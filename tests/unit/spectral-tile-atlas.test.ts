import { describe, expect, it, vi } from 'vitest';
import {
  createSpectralTilePlan,
  SpectralTileLru,
  SpectralWebGLAtlas,
  spectralAtlasLayout,
  type SpectralTileDescriptor,
} from '../../src/audio/SpectralTileAtlas';
import type { SpectrogramRenderOptions } from '../../src/audio/spectrogram';

describe('exact spectral tile planning', () => {
  it('uses stable scientific keys and limits prefetch to reusable adjacent zooms', () => {
    const first = createSpectralTilePlan(7, 30, 22_050, 513, 257, renderOptions());
    const displayOnly = createSpectralTilePlan(7, 30, 22_050, 513, 257, {
      ...renderOptions(),
      palette: 'magma',
      brightness: 2,
      contrast: 1.7,
    });
    expect(first.viewKey).toBe(displayOnly.viewKey);
    expect(first.visible.map((tile) => tile.key)).toEqual(
      displayOnly.visible.map((tile) => tile.key),
    );
    expect(first.visible).toHaveLength(6);
    expect(first.visible.every((tile) => tile.priority === 'visible')).toBe(true);
    expect(first.prefetch.length).toBeGreaterThan(0);
    expect(first.prefetch.every((tile) => tile.priority === 'adjacent')).toBe(true);
    expect(first.prefetch.every((tile) => tile.tileX >= 0 && tile.tileY >= 0)).toBe(true);
    expect(createSpectralTilePlan(8, 30, 22_050, 513, 257, renderOptions()).viewKey).not.toBe(
      first.viewKey,
    );
    expect(
      createSpectralTilePlan(7, 30, 22_050, 513, 257, {
        ...renderOptions(),
        channelMode: 'right',
      }).viewKey,
    ).not.toBe(first.viewKey);
    const linear = createSpectralTilePlan(7, 30, 22_050, 513, 257, {
      ...renderOptions(),
      frequencyScale: 'linear',
    });
    expect(linear.viewKey).not.toBe(first.viewKey);
    const adjustable = createSpectralTilePlan(7, 30, 22_050, 513, 257, {
      ...renderOptions(),
      frequencyScale: 'adjustable',
      frequencyWarp: 0.65,
    });
    const stronger = createSpectralTilePlan(7, 30, 22_050, 513, 257, {
      ...adjustable.visible[0].options,
      frequencyWarp: 0.8,
    });
    expect(adjustable.viewKey).not.toBe(first.viewKey);
    expect(stronger.viewKey).not.toBe(adjustable.viewKey);
    const zoomed = createSpectralTilePlan(7, 30, 22_050, 513, 257, {
      ...renderOptions(),
      timeStartSeconds: 2,
      timeEndSeconds: 18,
    });
    expect(zoomed.zoomLevel).not.toBe(first.zoomLevel);
    expect(first.visible[0].key).toContain('|x0:y0');
  });

  it('accounts bytes, follows LRU order, and disposes bitmap resources', () => {
    const evicted: string[] = [];
    const close = vi.fn();
    const cache = new SpectralTileLru(40, (key) => evicted.push(key));
    cache.set(cachedTile('a', 4));
    cache.set(cachedTile('b', 4, { width: 1, height: 1, close } as unknown as ImageBitmap));
    expect(cache.byteLength).toBe(36);
    expect(cache.get('a')).toBeDefined();
    cache.set(cachedTile('c', 4));
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(evicted).toContain('b');
    expect(close).toHaveBeenCalledOnce();
    cache.clear();
    expect(cache.byteLength).toBe(0);
    expect(cache.size).toBe(0);
  });

  it('caps the single-channel R32F slot atlas at texture and byte limits', () => {
    const layout = spectralAtlasLayout(4_096);
    expect(layout).not.toBeNull();
    expect(layout?.byteLength).toBeLessThanOrEqual(48 * 1024 * 1024);
    expect(layout?.width).toBeLessThanOrEqual(4_096);
    expect(layout?.height).toBeLessThanOrEqual(4_096);
    expect(layout?.capacity).toBeGreaterThan(100);
    expect(spectralAtlasLayout(128)).toBeNull();
  });
});

describe('WebGL atlas lifecycle', () => {
  it('falls back cleanly when WebGL2 is unavailable', () => {
    const owner = {
      createElement: () => ({ getContext: () => null }),
    } as unknown as Document;
    expect(SpectralWebGLAtlas.create(owner)).toBeNull();
  });

  it('uploads one-channel tiles and explicitly releases every GPU resource', () => {
    const { gl, loseContext } = fakeWebGl();
    const surface = document.createElement('canvas');
    const atlas = new SpectralWebGLAtlas(surface, gl);
    const tile = cachedTile('gpu', 4);
    tile.descriptor.width = 2;
    tile.descriptor.height = 2;
    expect(atlas.prepareTile(tile)).toBe(true);
    expect(atlas.render([tile], 2, 2, renderOptions())).toBe(surface);
    expect(gl.texSubImage2D).toHaveBeenCalledOnce();
    expect(gl.drawArrays).toHaveBeenCalledOnce();
    expect(
      atlas.render([tile], 2, 2, {
        ...renderOptions(),
        palette: 'plasma',
        brightness: 2,
      }),
    ).toBe(surface);
    expect(gl.texSubImage2D).toHaveBeenCalledOnce();
    expect(gl.drawArrays).toHaveBeenCalledTimes(2);
    atlas.render([tile], 2, 2, {
      ...renderOptions(),
      brightness: 99,
      contrast: -4,
    });
    expect(
      (gl.uniform1f as unknown as ReturnType<typeof vi.fn>).mock.calls
        .slice(-2)
        .map((call) => call[1]),
    ).toEqual([3, 0.25]);
    atlas.destroy();
    atlas.destroy();
    expect(gl.deleteTexture).toHaveBeenCalledTimes(2);
    expect(gl.deleteBuffer).toHaveBeenCalledOnce();
    expect(gl.deleteVertexArray).toHaveBeenCalledOnce();
    expect(gl.deleteProgram).toHaveBeenCalledOnce();
    expect(loseContext).toHaveBeenCalledOnce();
  });

  it('rejects GPU allocation and upload errors so callers can use Canvas2D', () => {
    const allocation = fakeWebGl();
    allocation.getError.mockReturnValueOnce(allocation.gl.OUT_OF_MEMORY);
    expect(() => new SpectralWebGLAtlas(document.createElement('canvas'), allocation.gl)).toThrow(
      /atlas allocation failed/,
    );

    const upload = fakeWebGl();
    const atlas = new SpectralWebGLAtlas(document.createElement('canvas'), upload.gl);
    upload.getError.mockReturnValueOnce(upload.gl.OUT_OF_MEMORY);
    expect(atlas.prepareTile(cachedTile('failed-upload', 1))).toBe(false);
    atlas.destroy();
  });
});

function renderOptions(): SpectrogramRenderOptions {
  return {
    timeStartSeconds: 0.137,
    timeEndSeconds: 23.731,
    lowFrequencyHz: 37,
    highFrequencyHz: 19_713,
    brightness: 1,
    contrast: 1,
    palette: 'viridis',
    channelMode: 'average',
    frequencyScale: 'logarithmic',
  };
}

function descriptor(key: string): SpectralTileDescriptor {
  return {
    key,
    viewKey: 'view',
    zoomLevel: 't0:f0',
    tileX: 0,
    tileY: 0,
    pixelX: 0,
    pixelY: 0,
    width: 1,
    height: 1,
    rasterWidth: 1,
    rasterHeight: 1,
    priority: 'visible',
    options: renderOptions(),
  };
}

function cachedTile(key: string, values: number, bitmap?: ImageBitmap) {
  return {
    descriptor: descriptor(key),
    db: new Float32Array(values),
    bitmap,
  };
}

function fakeWebGl() {
  const loseContext = vi.fn();
  const constants = {
    MAX_TEXTURE_SIZE: 1,
    TEXTURE_2D: 2,
    TEXTURE_MIN_FILTER: 3,
    TEXTURE_MAG_FILTER: 4,
    TEXTURE_WRAP_S: 5,
    TEXTURE_WRAP_T: 6,
    NEAREST: 7,
    CLAMP_TO_EDGE: 8,
    R32F: 9,
    RED: 10,
    FLOAT: 11,
    RGBA: 12,
    UNSIGNED_BYTE: 13,
    ARRAY_BUFFER: 14,
    STATIC_DRAW: 15,
    VERTEX_SHADER: 16,
    FRAGMENT_SHADER: 17,
    COMPILE_STATUS: 18,
    LINK_STATUS: 19,
    BLEND: 20,
    DEPTH_TEST: 21,
    COLOR_BUFFER_BIT: 22,
    TEXTURE0: 23,
    TEXTURE1: 24,
    TRIANGLE_STRIP: 25,
    UNPACK_ALIGNMENT: 26,
    NO_ERROR: 0,
    OUT_OF_MEMORY: 1_285,
  };
  const getError = vi.fn(() => constants.NO_ERROR);
  const gl = {
    ...constants,
    getParameter: vi.fn(() => 4_096),
    getError,
    createTexture: vi.fn(() => ({})),
    createShader: vi.fn(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ''),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => ''),
    deleteProgram: vi.fn(),
    createBuffer: vi.fn(() => ({})),
    createVertexArray: vi.fn(() => ({})),
    getUniformLocation: vi.fn(() => ({})),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    texImage2D: vi.fn(),
    bindVertexArray: vi.fn(),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    getAttribLocation: vi.fn(() => 0),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    isContextLost: vi.fn(() => false),
    viewport: vi.fn(),
    disable: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
    useProgram: vi.fn(),
    activeTexture: vi.fn(),
    uniform1i: vi.fn(),
    uniform1f: vi.fn(),
    uniform4f: vi.fn(),
    drawArrays: vi.fn(),
    flush: vi.fn(),
    pixelStorei: vi.fn(),
    texSubImage2D: vi.fn(),
    deleteTexture: vi.fn(),
    deleteBuffer: vi.fn(),
    deleteVertexArray: vi.fn(),
    getExtension: vi.fn((name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null)),
  };
  return { gl: gl as unknown as WebGL2RenderingContext, loseContext, getError };
}
