import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PanelProvider } from './components/PanelContext';
import { SessionConfigProvider } from './context/SessionConfigContext';
import { ThemeProvider } from './context/ThemeContext';
import './index.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider>
      <SessionConfigProvider>
        <PanelProvider>
          <App />
        </PanelProvider>
      </SessionConfigProvider>
    </ThemeProvider>
  </StrictMode>,
);
