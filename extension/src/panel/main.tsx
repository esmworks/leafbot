import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { uiLocale } from '../i18n';
import { App } from './App';
import './style.css';

document.documentElement.lang = uiLocale;
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
