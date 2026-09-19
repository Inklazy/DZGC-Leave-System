# DZGC Leave System

一个面向 VPS/Docker 的请假系统代理服务。它保留原站的登录、验证码和页面交互，同时为本地提交记录提供持久化 JSON 存储。

> **安全提示**：默认提交模式是 `local-only`，只保存本地记录，不会自动向学校原系统提交。只有显式设置 `LEAVE_SYSTEM_FORWARD_SUBMIT=1` 后，提交才会转发到原系统。

## 功能概览

- 原站页面与接口代理，支持原站登录会话。
- 本地申请记录持久化到 `applications.json`。
- 本地记录按账号/会话隔离，详情接口防止跨账号读取。
- 断开原站时可回退展示本地记录。
- Docker Compose 部署，数据目录独立于镜像。
- `/healthz` 健康检查，可用于 Docker、Caddy 或监控系统。
- 请求体、上游响应、JSON 深度和跨站写请求均有边界保护。

## 运行模式

### 默认：本地记录模式

`compose.yaml` 默认使用：

```env
LEAVE_SYSTEM_FORWARD_SUBMIT=0
```

提交接口会返回：

```json
{
  "localOnly": true,
  "mode": "local-only"
}
```

这表示记录已经写入本地 JSON，但不代表已经进入学校审批流程。

### 可选：转发到原系统

在部署目录创建 `.env`，不要把它提交到 Git：

```env
LEAVE_SYSTEM_FORWARD_SUBMIT=1
```

然后重启：

```bash
docker compose -f compose.yaml -f compose.vps-build.yaml up -d
```

转发模式依赖有效的原站登录会话，并由原系统返回真实提交结果。

## 本地开发与验证

项目没有 npm 依赖，要求 Node.js 24 或兼容版本：

```bash
npm test
npm run verify
```

常用脚本：

```bash
npm run generate  # 需要本地页面抓取输入 myhtml/
npm start        # 默认监听 8123
npm run test:live # 对已启动的本地服务做接口回归
```

`myhtml/` 是本地页面抓取输入，可能包含个人信息，已加入 `.gitignore`，不会进入 Git 仓库或 Docker 构建上下文。`leave-system-copy/` 是静态生成产物，同样只保留在本地；Docker 运行所需的 `leave-system-live-copy/` 已作为运行时资源纳入项目。

## Docker 部署

推荐在 VPS 本机构建镜像：

```bash
sudo mkdir -p /opt/leave-system-data
sudo chown -R 1000:1000 /opt/leave-system-data

cd /opt/leave-system
docker compose -f compose.yaml -f compose.vps-build.yaml build --pull
docker compose -f compose.yaml -f compose.vps-build.yaml up -d --no-build
docker compose -f compose.yaml -f compose.vps-build.yaml ps
```

容器信息：

```text
服务端口：127.0.0.1:8123
数据目录：/opt/leave-system-data -> /app/data
上游地址：LEAVE_SYSTEM_TARGET
健康检查：http://127.0.0.1:8123/healthz
```

完整部署、迁移、Caddy 和回滚步骤见 [`DEPLOY.md`](DEPLOY.md)。

## GitHub Actions / GHCR

推送到默认分支后，GitHub Actions 会运行测试并构建镜像。镜像地址：

```text
ghcr.io/zekty/dzgc-leave-system:latest
ghcr.io/zekty/dzgc-leave-system:sha-<commit>
```

## 数据与隐私

以下内容不应提交到仓库：

- `data/` 运行数据；
- `.env` 和其他部署密钥；
- 原始页面抓取目录 `myhtml/`；
- 本地生成的 `leave-system-copy/`；
- 包含真实账号、Cookie、Token 或个人信息的日志和压缩包。

运行数据请通过 Docker volume 或服务器备份单独管理。
