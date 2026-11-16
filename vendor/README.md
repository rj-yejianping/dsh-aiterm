# vendor/ssh2.cjs

`ssh2` 1.17.0 的**纯 JS** 构建产物，由 `scripts/build-vendor.mjs` 用 esbuild 打包成单文件。

## 为什么要打包

`ssh2` 本身是纯 JS（协议实现全在 `lib/**.js`），但它有两个**可选**的原生加速件：

- `cpu-features`（探测 CPU 指令集，用于调优包大小）——在 `lib/protocol/constants.js` 里 `try/catch` 加载；
- 内建的 `sshcrypto` 绑定（`lib/protocol/crypto.js` 里的 `try/catch`）——由 `ssh2` 自己的 `install` 脚本尝试用 node-gyp 编译。

两者都**缺失时 ssh2 自动回落到纯 JS 实现**，功能不受影响。

问题是 pnpm 10+ 默认**拦截一切安装脚本**：只要依赖图里出现 `install`/`postinstall`，
安装就会被挂起等人工批准（`ssh2` 的 `install` 脚本 + `cpu-features` 的 `node-gyp rebuild`）。
把它打包进本包之后，`dsh-aiterm` 的依赖图里**不再有任何安装脚本**，装包即用。

## 怎么重新生成

```bash
npm install                    # 需要 devDependency ssh2 与 esbuild
npm run build:vendor           # 重新生成 vendor/ssh2.cjs
```

打包时显式把两个原生件标记为 external，保持它们在运行时的 `try/catch` 里失败并回落：

```
--external:cpu-features --external:nan --external:./crypto/build/Release/sshcrypto.node
```

`ssh2` 的许可证见同目录 `ssh2.LICENSE`（MIT）。
