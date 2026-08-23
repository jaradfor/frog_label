import {
  createSpectrogramPaletteLut,
  type SpectrogramPalette,
  type SpectrogramRenderOptions,
} from './spectrogram';

export const SPECTRAL_TILE_SIZE = 256;
export const SPECTRAL_TILE_CACHE_BYTES = 48 * 1024 * 1024;
const ZOOM_FACTOR = 1.25;

export type SpectralTilePriority = 'visible' | 'adjacent';

export interface SpectralTileDescriptor {
  key: string;
  viewKey: string;
  zoomLevel: string;
  tileX: number;
  tileY: number;
  pixelX: number;
  pixelY: number;
  width: number;
  height: number;
  rasterWidth: number;
  rasterHeight: number;
  priority: SpectralTilePriority;
  options: SpectrogramRenderOptions;
}

export interface SpectralTilePlan {
  audioGeneration: number;
  viewKey: string;
  zoomLevel: string;
  visible: SpectralTileDescriptor[];
  prefetch: SpectralTileDescriptor[];
}

export interface CachedSpectralTile {
  descriptor: SpectralTileDescriptor;
  db: Float32Array;
  bitmap?: ImageBitmap | null;
}

/**
 * Exactness note: these are view-grid tiles, not interpolated world-raster
 * tiles. Arbitrary viewport offsets change the half-open STFT rectangle of
 * almost every output pixel, so cropping a fixed pooled world raster would
 * silently over-include samples. Including the exact view origin/span and
 * global raster size in the key lets independently computed 256px tiles stitch
 * bit-for-bit with monolithic peak pooling. Palette controls are excluded and
 * therefore remain GPU/Canvas lookup-only operations.
 */
export function createSpectralTilePlan(
  audioGeneration: number,
  durationSeconds: number,
  maximumFrequencyHz: number,
  rasterWidth: number,
  rasterHeight: number,
  options: SpectrogramRenderOptions,
): SpectralTilePlan {
  const width = Math.max(1, Math.round(rasterWidth));
  const height = Math.max(1, Math.round(rasterHeight));
  const current = tileViewIdentity(
    audioGeneration,
    durationSeconds,
    maximumFrequencyHz,
    width,
    height,
    options,
  );
  const visible = createViewDescriptors(current, 'visible');
  const visibleKeys = new Set(visible.map((tile) => tile.key));
  // Adjacent center-zoom jobs are best-effort warmups. Exact fractional pans
  // and pointer-anchored zooms receive a different viewKey and intentionally
  // do not claim these pixels as reusable scientific output. A ring outside
  // this exact view grid would likewise never match a future visible key, so
  // no scientifically dead overscan tiles are scheduled.
  const adjacent: SpectralTileDescriptor[] = [];
  for (const factor of [ZOOM_FACTOR, 1 / ZOOM_FACTOR]) {
    const adjacentOptions = centeredZoomOptions(
      options,
      factor,
      durationSeconds,
      maximumFrequencyHz,
    );
    const identity = tileViewIdentity(
      audioGeneration,
      durationSeconds,
      maximumFrequencyHz,
      width,
      height,
      adjacentOptions,
    );
    if (identity.viewKey === current.viewKey) continue;
    adjacent.push(...createViewDescriptors(identity, 'adjacent'));
  }
  const prefetchKeys = new Set<string>();
  const prefetch = adjacent.filter((tile) => {
    if (visibleKeys.has(tile.key) || prefetchKeys.has(tile.key)) return false;
    prefetchKeys.add(tile.key);
    return true;
  });
  return {
    audioGeneration,
    viewKey: current.viewKey,
    zoomLevel: current.zoomLevel,
    visible,
    prefetch,
  };
}

interface TileViewIdentity {
  audioGeneration: number;
  viewKey: string;
  zoomLevel: string;
  width: number;
  height: number;
  options: SpectrogramRenderOptions;
}

function tileViewIdentity(
  audioGeneration: number,
  durationSeconds: number,
  maximumFrequencyHz: number,
  width: number,
  height: number,
  options: SpectrogramRenderOptions,
): TileViewIdentity {
  const timeSpan = Math.max(Number.EPSILON, options.timeEndSeconds - options.timeStartSeconds);
  const frequencySpan = Math.max(Number.EPSILON, options.highFrequencyHz - options.lowFrequencyHz);
  const timeZoom = Math.round(
    Math.log(Math.max(1, durationSeconds / timeSpan)) / Math.log(ZOOM_FACTOR),
  );
  const frequencyZoom = Math.round(
    Math.log(Math.max(1, maximumFrequencyHz / frequencySpan)) / Math.log(ZOOM_FACTOR),
  );
  const zoomLevel = `t${timeZoom}:f${frequencyZoom}`;
  const viewKey = [
    'spectrogram-v1',
    `a${audioGeneration}`,
    options.channelMode ?? 'average',
    options.frequencyScale ?? 'linear',
    zoomLevel,
    numberKey(options.timeStartSeconds),
    numberKey(options.timeEndSeconds),
    numberKey(options.lowFrequencyHz),
    numberKey(options.highFrequencyHz),
    `${width}x${height}`,
  ].join('|');
  return {
    audioGeneration,
    viewKey,
    zoomLevel,
    width,
    height,
    options: { ...options },
  };
}

function createViewDescriptors(
  identity: TileViewIdentity,
  priority: SpectralTilePriority,
): SpectralTileDescriptor[] {
  const columnCount = Math.ceil(identity.width / SPECTRAL_TILE_SIZE);
  const rowCount = Math.ceil(identity.height / SPECTRAL_TILE_SIZE);
  const descriptors: SpectralTileDescriptor[] = [];
  for (let tileY = 0; tileY < rowCount; tileY += 1) {
    for (let tileX = 0; tileX < columnCount; tileX += 1) {
      const pixelX = tileX * SPECTRAL_TILE_SIZE;
      const pixelY = tileY * SPECTRAL_TILE_SIZE;
      const visibleWidth = Math.min(SPECTRAL_TILE_SIZE, identity.width - pixelX);
      const visibleHeight = Math.min(SPECTRAL_TILE_SIZE, identity.height - pixelY);
      const width = Math.max(1, Math.min(SPECTRAL_TILE_SIZE, visibleWidth));
      const height = Math.max(1, Math.min(SPECTRAL_TILE_SIZE, visibleHeight));
      descriptors.push({
        key: `${identity.viewKey}|x${tileX}:y${tileY}`,
        viewKey: identity.viewKey,
        zoomLevel: identity.zoomLevel,
        tileX,
        tileY,
        pixelX,
        pixelY,
        width,
        height,
        rasterWidth: identity.width,
        rasterHeight: identity.height,
        priority,
        options: { ...identity.options },
      });
    }
  }
  return descriptors;
}

function centeredZoomOptions(
  options: SpectrogramRenderOptions,
  factor: number,
  durationSeconds: number,
  maximumFrequencyHz: number,
): SpectrogramRenderOptions {
  const timeSpan = options.timeEndSeconds - options.timeStartSeconds;
  const nextTimeSpan = clamp(timeSpan / factor, Math.min(0.25, durationSeconds), durationSeconds);
  const timeCenter = (options.timeStartSeconds + options.timeEndSeconds) / 2;
  const timeStartSeconds = clamp(timeCenter - nextTimeSpan / 2, 0, durationSeconds - nextTimeSpan);

  let lowFrequencyHz: number;
  let highFrequencyHz: number;
  if (
    options.frequencyScale === 'logarithmic' &&
    options.lowFrequencyHz > 0 &&
    options.highFrequencyHz > options.lowFrequencyHz
  ) {
    const lowLog = Math.log(options.lowFrequencyHz);
    const highLog = Math.log(options.highFrequencyHz);
    const centerLog = (lowLog + highLog) / 2;
    const spanLog = (highLog - lowLog) / factor;
    const minimumLog = Math.log(Math.max(Number.MIN_VALUE, Math.min(options.lowFrequencyHz, 1)));
    const maximumLog = Math.log(maximumFrequencyHz);
    const boundedSpan = Math.min(maximumLog - minimumLog, spanLog);
    const nextLowLog = clamp(centerLog - boundedSpan / 2, minimumLog, maximumLog - boundedSpan);
    lowFrequencyHz = Math.exp(nextLowLog);
    highFrequencyHz = Math.exp(nextLowLog + boundedSpan);
  } else {
    const span = options.highFrequencyHz - options.lowFrequencyHz;
    const nextSpan = clamp(span / factor, Math.min(1, maximumFrequencyHz), maximumFrequencyHz);
    const center = (options.lowFrequencyHz + options.highFrequencyHz) / 2;
    lowFrequencyHz = clamp(center - nextSpan / 2, 0, maximumFrequencyHz - nextSpan);
    highFrequencyHz = lowFrequencyHz + nextSpan;
  }
  return {
    ...options,
    timeStartSeconds,
    timeEndSeconds: timeStartSeconds + nextTimeSpan,
    lowFrequencyHz,
    highFrequencyHz,
  };
}

function numberKey(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Object.is(value, -0) ? '-0' : value.toPrecision(17);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export class SpectralTileLru {
  private readonly values = new Map<string, CachedSpectralTile>();
  private usedBytes = 0;

  constructor(
    readonly maximumBytes = SPECTRAL_TILE_CACHE_BYTES,
    private readonly onEvict: (key: string) => void = () => undefined,
  ) {}

  get byteLength(): number {
    return this.usedBytes;
  }

  get size(): number {
    return this.values.size;
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  get(key: string): CachedSpectralTile | undefined {
    const value = this.values.get(key);
    if (!value) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(value: CachedSpectralTile): boolean {
    const bytes = spectralTileBytes(value);
    const prior = this.values.get(value.descriptor.key);
    if (prior) {
      this.values.delete(value.descriptor.key);
      this.usedBytes -= spectralTileBytes(prior);
      disposeCachedTile(prior);
      this.onEvict(value.descriptor.key);
    }
    if (bytes > this.maximumBytes) {
      disposeCachedTile(value);
      return false;
    }
    this.values.set(value.descriptor.key, value);
    this.usedBytes += bytes;
    while (this.usedBytes > this.maximumBytes) {
      const oldestKey = this.values.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }
    return true;
  }

  delete(key: string): boolean {
    const value = this.values.get(key);
    if (!value) return false;
    this.values.delete(key);
    this.usedBytes -= spectralTileBytes(value);
    disposeCachedTile(value);
    this.onEvict(key);
    return true;
  }

  clear(): void {
    for (const [key, value] of this.values) {
      disposeCachedTile(value);
      this.onEvict(key);
    }
    this.values.clear();
    this.usedBytes = 0;
  }
}

function spectralTileBytes(value: CachedSpectralTile): number {
  const bitmapBytes = value.bitmap
    ? Math.max(0, value.bitmap.width) * Math.max(0, value.bitmap.height) * 4
    : 0;
  return value.db.byteLength + bitmapBytes;
}

function disposeCachedTile(value: CachedSpectralTile): void {
  value.bitmap?.close();
  value.bitmap = null;
}

export interface SpectralAtlasLayout {
  columns: number;
  rows: number;
  capacity: number;
  width: number;
  height: number;
  byteLength: number;
}

export function spectralAtlasLayout(
  maximumTextureSize: number,
  maximumBytes = SPECTRAL_TILE_CACHE_BYTES,
): SpectralAtlasLayout | null {
  const maximumAcross = Math.floor(maximumTextureSize / SPECTRAL_TILE_SIZE);
  const maximumSlots = Math.floor(maximumBytes / (SPECTRAL_TILE_SIZE ** 2 * 4));
  if (maximumAcross < 1 || maximumSlots < 1) return null;
  let bestColumns = 1;
  let bestRows = 1;
  let bestCapacity = 1;
  let bestSkew = Number.POSITIVE_INFINITY;
  for (let columns = 1; columns <= maximumAcross; columns += 1) {
    const rows = Math.min(maximumAcross, Math.floor(maximumSlots / columns));
    if (rows < 1) continue;
    const capacity = columns * rows;
    const skew = Math.abs(columns - rows);
    if (capacity > bestCapacity || (capacity === bestCapacity && skew < bestSkew)) {
      bestColumns = columns;
      bestRows = rows;
      bestCapacity = capacity;
      bestSkew = skew;
    }
  }
  return {
    columns: bestColumns,
    rows: bestRows,
    capacity: bestCapacity,
    width: bestColumns * SPECTRAL_TILE_SIZE,
    height: bestRows * SPECTRAL_TILE_SIZE,
    byteLength: bestCapacity * SPECTRAL_TILE_SIZE ** 2 * 4,
  };
}

interface AtlasSlot {
  slot: number;
  touched: number;
}

export class SpectralWebGLAtlas {
  readonly surface: HTMLCanvasElement;
  readonly layout: SpectralAtlasLayout;
  private readonly atlasTexture: WebGLTexture;
  private readonly paletteTexture: WebGLTexture;
  private readonly program: WebGLProgram;
  private readonly vertexBuffer: WebGLBuffer;
  private readonly vertexArray: WebGLVertexArrayObject;
  private readonly rectUniform: WebGLUniformLocation;
  private readonly uvUniform: WebGLUniformLocation;
  private readonly brightnessUniform: WebGLUniformLocation;
  private readonly contrastUniform: WebGLUniformLocation;
  private readonly slots = new Map<string, AtlasSlot>();
  private readonly freeSlots: number[] = [];
  private clock = 0;
  private currentPalette: SpectrogramPalette | null = null;
  private destroyed = false;

  static create(
    ownerDocument: Document,
    maximumBytes = SPECTRAL_TILE_CACHE_BYTES,
  ): SpectralWebGLAtlas | null {
    const canvas = ownerDocument.createElement('canvas');
    const context = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    });
    if (!context || typeof context.createShader !== 'function') return null;
    try {
      return new SpectralWebGLAtlas(canvas, context, maximumBytes);
    } catch {
      context.getExtension('WEBGL_lose_context')?.loseContext();
      return null;
    }
  }

  constructor(
    surface: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
    maximumBytes = SPECTRAL_TILE_CACHE_BYTES,
  ) {
    this.surface = surface;
    const layout = spectralAtlasLayout(Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)), maximumBytes);
    if (!layout) throw new Error('WebGL texture limits cannot hold one spectral tile.');
    this.layout = layout;
    this.atlasTexture = requiredResource(gl.createTexture(), 'spectral atlas texture');
    this.paletteTexture = requiredResource(gl.createTexture(), 'spectral palette texture');
    this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.vertexBuffer = requiredResource(gl.createBuffer(), 'spectral vertex buffer');
    this.vertexArray = requiredResource(gl.createVertexArray(), 'spectral vertex array');
    this.rectUniform = requiredUniform(gl, this.program, 'u_rect');
    this.uvUniform = requiredUniform(gl, this.program, 'u_uv');
    this.brightnessUniform = requiredUniform(gl, this.program, 'u_brightness');
    this.contrastUniform = requiredUniform(gl, this.program, 'u_contrast');

    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32F,
      layout.width,
      layout.height,
      0,
      gl.RED,
      gl.FLOAT,
      null,
    );

    gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindVertexArray(this.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(this.program, 'a_position');
    if (position < 0) throw new Error('Spectral compositor position attribute is unavailable.');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    for (let slot = layout.capacity - 1; slot >= 0; slot -= 1) this.freeSlots.push(slot);
  }

  releaseTile(key: string): void {
    const mapped = this.slots.get(key);
    if (!mapped) return;
    this.slots.delete(key);
    this.freeSlots.push(mapped.slot);
  }

  /**
   * Uploads one tile without drawing it. The renderer uses this small primitive
   * to cooperatively fill the atlas across host tasks before one atomic frame
   * composition; `render` remains self-contained for callers that do not need
   * cooperative scheduling.
   */
  prepareTile(tile: CachedSpectralTile): boolean {
    if (this.destroyed || this.gl.isContextLost()) return false;
    this.upload(tile);
    return true;
  }

  render(
    tiles: readonly CachedSpectralTile[],
    width: number,
    height: number,
    options: SpectrogramRenderOptions,
  ): HTMLCanvasElement | null {
    if (this.destroyed || this.gl.isContextLost()) return null;
    const gl = this.gl;
    if (this.surface.width !== width) this.surface.width = width;
    if (this.surface.height !== height) this.surface.height = height;
    this.updatePalette(options.palette);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(16 / 255, 23 / 255, 19 / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vertexArray);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_atlas'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_palette'), 1);
    gl.uniform1f(this.brightnessUniform, clamp(options.brightness, 0.25, 3));
    gl.uniform1f(this.contrastUniform, clamp(options.contrast ?? 1, 0.25, 4));

    for (const tile of tiles) {
      const mapped = this.upload(tile);
      const descriptor = tile.descriptor;
      const destinationLeft = (descriptor.pixelX / width) * 2 - 1;
      const destinationRight = ((descriptor.pixelX + descriptor.width) / width) * 2 - 1;
      const destinationTop = 1 - (descriptor.pixelY / height) * 2;
      const destinationBottom = 1 - ((descriptor.pixelY + descriptor.height) / height) * 2;
      const slotX = (mapped.slot % this.layout.columns) * SPECTRAL_TILE_SIZE;
      const slotY = Math.floor(mapped.slot / this.layout.columns) * SPECTRAL_TILE_SIZE;
      const u0 = slotX / this.layout.width;
      const u1 = (slotX + descriptor.width) / this.layout.width;
      const vTop = slotY / this.layout.height;
      const vBottom = (slotY + descriptor.height) / this.layout.height;
      gl.uniform4f(
        this.rectUniform,
        destinationLeft,
        destinationBottom,
        destinationRight,
        destinationTop,
      );
      gl.uniform4f(this.uvUniform, u0, vBottom, u1, vTop);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindVertexArray(null);
    gl.flush();
    return this.surface;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const gl = this.gl;
    this.slots.clear();
    this.freeSlots.length = 0;
    gl.deleteTexture(this.atlasTexture);
    gl.deleteTexture(this.paletteTexture);
    gl.deleteBuffer(this.vertexBuffer);
    gl.deleteVertexArray(this.vertexArray);
    gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  private upload(tile: CachedSpectralTile): AtlasSlot {
    const existing = this.slots.get(tile.descriptor.key);
    if (existing) {
      existing.touched = ++this.clock;
      return existing;
    }
    let slot = this.freeSlots.pop();
    if (slot === undefined) {
      let oldestKey: string | null = null;
      let oldestTouched = Number.POSITIVE_INFINITY;
      for (const [key, candidate] of this.slots) {
        if (candidate.touched < oldestTouched) {
          oldestKey = key;
          oldestTouched = candidate.touched;
          slot = candidate.slot;
        }
      }
      if (oldestKey === null || slot === undefined) throw new Error('Spectral atlas has no slot.');
      this.slots.delete(oldestKey);
    }
    const mapped = { slot, touched: ++this.clock };
    this.slots.set(tile.descriptor.key, mapped);
    const x = (slot % this.layout.columns) * SPECTRAL_TILE_SIZE;
    const y = Math.floor(slot / this.layout.columns) * SPECTRAL_TILE_SIZE;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      x,
      y,
      tile.descriptor.width,
      tile.descriptor.height,
      gl.RED,
      gl.FLOAT,
      tile.db as Float32Array<ArrayBuffer>,
    );
    return mapped;
  }

  private updatePalette(palette: SpectrogramPalette): void {
    if (this.currentPalette === palette) return;
    this.currentPalette = palette;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      256,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      createSpectrogramPaletteLut(palette),
    );
  }
}

function requiredResource<T>(resource: T | null, name: string): T {
  if (!resource) throw new Error(`Unable to allocate ${name}.`);
  return resource;
}

function requiredUniform(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  return requiredResource(gl.getUniformLocation(program, name), `${name} uniform`);
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = requiredResource(gl.createProgram(), 'spectral shader program');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? 'Unknown shader link error';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = requiredResource(gl.createShader(type), 'spectral shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? 'Unknown shader compilation error';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
uniform vec4 u_rect;
uniform vec4 u_uv;
out vec2 v_uv;
void main() {
  gl_Position = vec4(mix(u_rect.xy, u_rect.zw, a_position), 0.0, 1.0);
  v_uv = mix(u_uv.xy, u_uv.zw, a_position);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_atlas;
uniform sampler2D u_palette;
uniform float u_brightness;
uniform float u_contrast;
in vec2 v_uv;
out vec4 outputColor;
void main() {
  float db = texture(u_atlas, v_uv).r;
  float quantized = floor(clamp((db + 120.0) / 120.0, 0.0, 1.0) * 4095.0 + 0.5);
  float shifted = (-120.0 + quantized * (120.0 / 4095.0)) + (u_brightness - 1.0) * 18.0;
  float normalized = clamp(((shifted + 120.0) / 120.0 - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  outputColor = texture(u_palette, vec2((normalized * 255.0 + 0.5) / 256.0, 0.5));
}`;
