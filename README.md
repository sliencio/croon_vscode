# Ting Reader for VS Code

在桌面版 VS Code 中连接 Ting Reader，边写代码边听书。播放进度通过 Ting Reader 服务器同步，可在同一账号的其他客户端继续收听。

## 安装与使用

1. 打开 VS Code 扩展视图右上角的菜单，选择「从 VSIX 安装」，或运行 `code --install-extension ting-reader-vscode-0.1.0.vsix`。
2. 打开命令面板，运行 **Ting Reader: 浏览书库**。首次使用时输入 Ting Reader 服务器地址、用户名和密码。地址支持反向代理路径前缀，例如 `https://example.com/ting`。
3. 选择媒体库，再按书名、作者或演播者查找书籍。打开播放器后，点击「播放」即可从当前账号的收听进度开始。章节结束后会自动接播。
4. 播放器可搜索章节、跳转进度、快退 15 秒、快进 30 秒，以及调整速度和音量。切换编辑器标签页可继续收听，关闭播放器标签页会停止播放。
5. 用 **Ting Reader: 继续收听** 从最近收听记录进入，或通过状态栏的 **Ting Reader** 回到播放器。换账号时运行 **Ting Reader: 登录或切换账号**。

需要可从桌面 VS Code 访问的 Ting Reader 2.x 服务器。服务端原始音频优先直放，加载失败会尝试由服务端 FFmpeg 转成 MP3。转码模式按服务端报告的章节时长定位，时长未知时可使用快退或切章。插件使用 VS Code 的 SecretStorage 保存登录令牌，密码只在登录时使用。音频通过本机回环地址转发，播放器不会接收服务端登录令牌。进度在开始、暂停、直放跳转和播完时同步，收听期间约每 10 秒同步一次。

## 开发与打包

用 VS Code 打开仓库并按 `F5` 启动扩展开发宿主。项目的运行时无需安装 npm 依赖。

```sh
npm ci
npm run check
npm run package
```

生成的 `ting-reader-vscode-0.1.0.vsix` 位于项目根目录。
