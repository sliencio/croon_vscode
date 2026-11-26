# Croon for VS Code

在桌面版 VS Code 的左侧边栏连接 Croon，边写代码边听书。播放进度通过 Croon 服务器同步，可在同一账号的其他客户端继续收听。

## 安装与使用

1. 从 [GitHub Releases](https://github.com/sliencio/croon_vscode/releases/latest) 下载 `.vsix`。打开 VS Code 扩展视图右上角的菜单，选择「从 VSIX 安装」。
2. 点击 VS Code 最左侧活动栏里的 **耳廓 C 图标**。首次使用时点「登录 Croon」，输入服务器地址、用户名和密码。地址支持反向代理路径前缀，例如 `https://example.com/croon`。
3. 在左侧边栏浏览书库、搜索书名，或从「续听」选择最近收听过的书。播放器会在同一侧边栏显示。点击「播放」从已保存的进度继续。
4. 在播放器里可以搜索章节、快退 15 秒、快进 30 秒，以及调整倍速和音量。章节播完会自动接播。切到资源管理器继续写代码，音频会在后台播放。暂停时可切回 Croon 点「暂停」。
5. 活动栏隐藏时，可在命令面板运行 **Croon: 打开播放器**。切换账号或退出登录，可使用 Croon 侧边栏标题处的更多菜单。在菜单中选择「强制同步」可更新书库和本地封面缓存，选择「关于」可查看插件和服务器版本。

需要可从桌面 VS Code 访问的 Croon 2.x 服务器。服务端原始音频优先直放，加载失败会尝试由服务端 FFmpeg 转成 MP3。转码模式按服务端报告的章节时长定位，时长未知时可使用快退或切章。插件使用 VS Code 的 SecretStorage 保存登录令牌，密码只在登录时使用。音频通过本机回环地址转发，播放器不会接收服务端登录令牌。进度在开始、暂停、直放跳转和播完时同步，收听期间约每 10 秒同步一次。

## 开发与发布

用 VS Code 打开仓库并按 `F5` 启动扩展开发宿主。项目的运行时无需安装 npm 依赖。

```sh
npm ci
npm run check
npm run package
```

VSIX 生成在项目根目录。推送与 `package.json` 版本相同的 `v` 前缀标签后，GitHub Actions 会打包并将 VSIX 上传到对应的 GitHub Release。已有标签可在 GitHub Actions 页面手动运行「发布 VS Code 插件」补发。
