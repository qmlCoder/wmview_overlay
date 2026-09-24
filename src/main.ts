import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import Sider from './Sider.vue'
import { plugin } from './index'

// 仅用于在浏览器直接打开 dev server 时预览插件面板；
// 由主程序(MF Host)加载时，主程序会直接使用 plugin.sider.comp 挂载，不走这里。
const app = createApp(Sider)
app.use(ElementPlus)
app.mount('#app')
console.log('[overlay] dev preview plugin:', plugin.name)
