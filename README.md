# MelodyBox

网易云音乐在线播放器。

## 环境准备

1. 安装 [Node.js](https://nodejs.org/)（LTS 版本）
2. 安装 NeteaseCloudMusicApi：

```bash
mkdir NeteaseCloudMusicApi
cd NeteaseCloudMusicApi
npm init -y
npm install NeteaseCloudMusicApi
```

3. 在该目录下创建 `app.js`：

```js
require('./node_modules/NeteaseCloudMusicApi/app.js');
```

4. 修改 `启动.bat` 中的 `API_DIR` 为你的 NeteaseCloudMusicApi 目录路径

## 启动

双击 `启动.bat`，首次启动会自动打开浏览器 → 扫码登录网易云 → 加载歌单 → 播放。

## 技术栈

- 前端：原生 HTML/CSS/JS，Web Audio API 频谱
- 后端：NeteaseCloudMusicApi（Node.js）+ 内置静态服务器
- 无框架依赖，无需 Python

## 功能

- 网易云扫码登录
- 歌单分类浏览（支持切换）
- 封面 + 毛玻璃背景
- 双语歌词（自动合并翻译）
- 频谱可视化
- 键盘快捷键（空格暂停 / ←→快进 / ↑↓音量）
- 系统媒体控制（锁屏 / 耳机线控）
- 进度拖拽 / 播放速度 / 歌词偏移
