import React from 'react';
import ReactDOM from 'react-dom/client';
import { ToastProvider } from './hooks/useToast';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </React.StrictMode>
);
