import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const supabaseUrl = String(env.VITE_SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  const supabaseDevProxy = supabaseUrl
    ? {
        "/__supabase": {
          target: supabaseUrl,
          changeOrigin: true,
          secure: true,
          rewrite: (path: string) => path.replace(/^\/__supabase/, ""),
        },
      }
    : undefined;

  return {
    base: "./",
    plugins: [
      react(),
      {
        name: "messly-csp-dev-eval-token",
        transformIndexHtml(html) {
          const scriptEvalToken = mode === "production" ? "" : "'unsafe-eval'";
          const devLocalGatewaySources =
            "http://localhost:8788 http://127.0.0.1:8788 ws://localhost:8788 ws://127.0.0.1:8788";
          const devConnectSources =
            mode === "production"
              ? ""
              : devLocalGatewaySources;
          const devImageSources =
            mode === "production"
              ? ""
              : "http://localhost:8788 http://127.0.0.1:8788";
          return html
            .replace(/__CSP_SCRIPT_EVAL__/g, scriptEvalToken)
            .replace(/__CSP_DEV_CONNECT__/g, devConnectSources)
            .replace(/__CSP_DEV_IMG__/g, devImageSources)
            .replace(/__CSP_DEV_MEDIA__/g, devImageSources);
        },
      },
    ],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      origin: "http://127.0.0.1:5173",
      proxy: supabaseDevProxy,
      hmr: {
        host: "127.0.0.1",
        protocol: "ws",
        port: 5173,
        clientPort: 5173,
      },
    },
    build: {
      sourcemap: false,
      minify: "terser",
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalized = id.replace(/\\/g, "/");

            if (normalized.includes("/node_modules/")) {
              if (
                normalized.includes("/react/") ||
                normalized.includes("/react-dom/") ||
                normalized.includes("/react-router-dom/") ||
                normalized.includes("/react-redux/") ||
                normalized.includes("/@reduxjs/") ||
                normalized.includes("/@tanstack/react-query/")
              ) {
                return "vendor-react";
              }

              if (normalized.includes("/@supabase/")) {
                return "vendor-supabase";
              }

              if (
                normalized.includes("/gsap/") ||
                normalized.includes("/twemoji/") ||
                normalized.includes("/emoji-picker-react/")
              ) {
                return "vendor-rich-ui";
              }

              if (normalized.includes("/dexie/")) {
                return "vendor-storage";
              }

              return undefined;
            }

            if (
              normalized.includes("/src/components/chat/DirectMessageChatView.tsx") ||
              normalized.includes("/src/components/chat/EmojiPopover.tsx") ||
              normalized.includes("/src/components/chat/VideoCallPanel.tsx")
            ) {
              return "chat-view";
            }

            if (normalized.includes("/src/components/settings/AppSettingsView.tsx")) {
              return "settings";
            }

            if (normalized.includes("/src/components/UserProfilePopover/UserProfilePopover.tsx")) {
              return "profile-popover";
            }

            return undefined;
          },
        },
      },
      terserOptions: {
        compress: {
          passes: 2,
        },
        format: {
          comments: false,
        },
      },
    },
  };
});
