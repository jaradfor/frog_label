import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import appCss from '../App.css?inline';
import { EmbeddedCatalogPort } from '../adapters/enterprise/EmbeddedCatalogPort';
import {
  EnterpriseInterfacePort,
  enterpriseInputSchema,
  enterpriseOutputSchema,
  enterpriseParamsSchema,
  getEnterpriseInterfaceResults,
  parseEnterpriseInterfaceResults,
  type EnterpriseInterfaceHostProps,
} from '../adapters/enterprise/EnterpriseInterfacePort';
import { HostAudioSourcePort } from '../adapters/reactcode/HostAudioSourcePort';
import { FrogLabelWorkspace } from '../components/workspace/FrogLabelWorkspace';
import type { SpeciesCatalog } from '../domain/types';
import { embeddedTutorialAudioUrl } from './tutorialAudio';

declare const __FROGLABEL_BUILD_VERSION__: string;

interface EnterpriseApplicationProps {
  host: EnterpriseInterfaceHostProps;
  catalog: SpeciesCatalog;
}

function EnterpriseApplication({ host, catalog }: EnterpriseApplicationProps) {
  const annotationRef = useRef<EnterpriseInterfacePort | null>(null);
  if (!annotationRef.current) annotationRef.current = new EnterpriseInterfacePort(host);
  const annotation = annotationRef.current;
  const dependencies = useMemo(() => {
    const species = new EmbeddedCatalogPort(catalog, annotation);
    return {
      species,
      audio: new HostAudioSourcePort(annotation),
    };
  }, [annotation, catalog]);
  const tutorialAudioSource = useMemo(
    () => ({
      url: embeddedTutorialAudioUrl(),
      filename: 'green-treefrog-hyla-cinerea.mp3',
      mimeType: 'audio/mpeg',
      trustedSampleRateHz: 48_000,
    }),
    [],
  );

  useLayoutEffect(() => annotation.updateContext(host), [annotation, host]);
  useEffect(
    () => () => {
      dependencies.audio.destroy();
      dependencies.species.destroy();
      annotation.destroy();
    },
    [annotation, dependencies],
  );

  return (
    <div
      className="froglabel-enterprise-root"
      data-froglabel-build={__FROGLABEL_BUILD_VERSION__}
      data-region-id={annotation.getSnapshot().regionId ?? undefined}
    >
      <style>{appCss}</style>
      <FrogLabelWorkspace
        annotationPort={annotation}
        catalogPort={dependencies.species}
        audioSourcePort={dependencies.audio}
        mode="embedded"
        speciesCreateScope="annotation"
        tutorialAudioSource={tutorialAudioSource}
        persistenceLabel="Ready to submit"
        headerExtras={<span className="mode-badge">Enterprise</span>}
      />
    </div>
  );
}

export function renderEnterpriseFrogLabel(
  host: EnterpriseInterfaceHostProps,
  catalog: SpeciesCatalog,
) {
  return <EnterpriseApplication host={host} catalog={catalog} />;
}

export const paramsSchema = enterpriseParamsSchema;
export const inputSchema = enterpriseInputSchema;
export const outputSchema = enterpriseOutputSchema;
export const getResults = getEnterpriseInterfaceResults;
export const parseResults = parseEnterpriseInterfaceResults;
