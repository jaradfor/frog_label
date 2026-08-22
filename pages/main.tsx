import { createRoot } from 'react-dom/client';
import '../src/index.css';
import { DemoApp, LocalApp } from '../src/App';

const root = document.getElementById('root');
if (!root) throw new Error('FrogLabel static demo root is missing');

const locationUrl = new URL(window.location.href);
const baseUrl = new URL(import.meta.env.BASE_URL, locationUrl.origin);
const localMode =
  locationUrl.searchParams.get('mode') === 'local' || locationUrl.hash === '#own-audio';
const demoHref = baseUrl.pathname;
const ownAudioHref = `${baseUrl.pathname}?mode=local`;

createRoot(root).render(
  localMode ? <LocalApp demoHref={demoHref} /> : <DemoApp ownAudioHref={ownAudioHref} />,
);
