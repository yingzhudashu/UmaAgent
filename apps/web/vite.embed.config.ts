import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  css: {
    postcss: {
      plugins: [
        {
          postcssPlugin: "uma-external-fonts",
          Declaration(declaration) {
            // Library 构建默认把字体转为 base64，令 CSS 超过宿主资源预算。
            // 使用 Vite 的显式 no-inline，完整保留字体并按需加载、独立缓存。
            if (declaration.prop === "src")
              declaration.value = declaration.value.replace(
                /url\((fonts\/[^)]+\.(?:woff2?|ttf))\)/g,
                "url($1?no-inline)",
              );
          },
        },
      ],
    },
  },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    assetsDir: "",
    emptyOutDir: true,
    outDir: "dist-embed",
    sourcemap: true,
    cssCodeSplit: false,
    rolldownOptions: {
      output: {
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith(".css")) ? "uma-embed.css" : "[name]-[hash][extname]",
      },
    },
    lib: {
      entry: "src/embed.tsx",
      formats: ["es"],
      fileName: () => "uma-embed.js",
      cssFileName: "uma-embed",
    },
  },
});
