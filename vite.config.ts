import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import { federation } from '@module-federation/vite'

export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
    federation({
      // 名称规则：安装目录 wmview.<短名> 对应 remote 名 wmview_<短名>。
      // 开发联调时主程序 dev.ts 只写死自动加载 wmview_xtb，如需 DEV 自动加载，
      // 可临时把这里改成 'wmview_xtb'（见 开发指南.md）。
      name: 'wmview_overlay',
      filename: 'index.js', // 入口文件名固定，主程序只认 index.js
      exposes: {
        './index': './src/index.ts', // 与第 5 步导出插件的文件保持一致
      },
      // 暴露模块时把组件样式一起带上，避免消费端拿不到 CSS
      bundleAllCSS: true,
      // 插件侧不生成给消费端用的类型（类型由主程序 wmapi d.ts + 插件 d.ts 维护）
      dts: false,
      // vue/element-plus 由主程序(MF Host)以 singleton 提供，插件不再各自打包
      shared: {
        vue: { singleton: true, requiredVersion: false },
        'element-plus': { singleton: true, requiredVersion: false },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // 插件产物被宿主放到 plugs/wmview.overlay/ 子目录下加载（asset.localhost），
  // 必须使用相对 base，否则 new URL('..wasm, import.meta.url) 等资源引用会变成
  // 从宿主根目录解析的绝对路径(/assets/..)而 404。
  base: './',
  server: {
    // 固定端口：主程序 dev 启动时自动加载 http://localhost:3001/index.js
    port: 3001,
    strictPort: true,
    cors: true,
    hmr: true,
    origin: 'http://localhost:3001',
  },
  build: {
    // 保持产物可读，便于调试
    minify: false,
  },
})
