import React from "react";
import ReactDOM from "react-dom/client";
import { BaseUIProvider, ToastProvider } from "./components/ui/base-ui";
import { ThemeProvider } from "./components/theme-provider";
import App from "./App";
import "./styles/globals.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <BaseUIProvider>
        <ToastProvider placement="bottom-right" />
        <main className="text-foreground bg-background">
          <App />
        </main>
      </BaseUIProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
