# Docker 部署指南：GitHub Actions + GHCR 优先

1. **推荐：GitHub Actions + GHCR**。GitHub 构建镜像，VPS 只 pull / up，不需要构建源码。
2. **备用：VPS 本地构建**。仅在 GitHub Actions / GHCR 不可用时使用 `compose.vps-build.yaml`。

两条路线都保留容器端口 `8123`、`127.0.0.1:8123:8123`、`/opt/leave-system-data:/app/data` 和 Dockerfile 中的 `/healthz` healthcheck。默认提交仍为 local-only；如需转发，在部署目录 `.env` 设置 `LEAVE_SYSTEM_FORWARD_SUBMIT=1` 后重新执行对应路线的 Compose up，且需要有效原站登录会话。其他环境变量行为不变。

## 一、GitHub Actions + GHCR（推荐）

仓库：`https://github.com/Inklazy/DZGC-Leave-System`。

### 自动验证与发布

工作流 `Build and publish Docker image` 使用内置 `GITHUB_TOKEN`，不需要额外 PAT 或 Registry Secret。镜像名从 `${{ github.repository }}` 转小写生成，发布 job 权限为 `contents: read`、`packages: write`。

| 触发方式 | 验证/构建 | 发布标签 |
| --- | --- | --- |
| push main | 测试、verify、Compose 检查、Buildx | `latest`、`sha-xxxxxxx` |
| push v* tag，如 v1.0.0 | 同上 | `v1.0.0`、`sha-xxxxxxx`，不覆盖 latest |
| workflow_dispatch，选择 main / v* tag | 同上 | 按上述 ref 规则发布 |
| workflow_dispatch，选择其他分支 | 同上 | 仅构建，不登录或推送 |
| pull_request | 同上 | 仅构建，不登录或推送 |

目标镜像：

```text
ghcr.io/inklazy/dzgc-leave-system:latest
ghcr.io/inklazy/dzgc-leave-system:sha-abcdef1
ghcr.io/inklazy/dzgc-leave-system:v1.0.0
```

构建仅针对 `linux/amd64`，使用 GitHub Actions Docker layer cache。验证失败则不会进入镜像构建/发布 job。

`npm run verify` 检查已入库的 live 页面、运行时文件、guard 和服务行为标记。原完整验证依赖被 gitignore 排除的私有 `myhtml/` 和本地 `leave-system-copy/`，因此保留为 `npm run verify:local`；CI 不生成或上传这些目录，也不会忽略部署验证失败。

### 首次发布后的 GitHub 网页设置

1. 在仓库 **Actions** 确认工作流启用，提交到 main 后等待运行成功。仓库/组织策略须允许所用 Actions 和 `GITHUB_TOKEN` 写入 Packages；无需创建 PAT。
2. 进入 **Inklazy 个人主页 → Packages → dzgc-leave-system → Package settings → Danger Zone → Change visibility → Public**，确认更改。公开仓库不代表新 Package 自动公开；此操作需要你手动完成。
3. 工作流显式写入 `org.opencontainers.image.source` 指向当前仓库，并使用仓库的 `GITHUB_TOKEN` 发布，以关联 Repository / Package。检查包页面关联到 `Inklazy/DZGC-Leave-System`。如果同名包此前由其他方式创建，需在包设置连接仓库，并在 **Manage Actions access** 授予当前仓库写权限。
4. Public 后，VPS 可以免登录拉取，无需 `docker login`：

```bash
docker pull ghcr.io/inklazy/dzgc-leave-system:latest
```

仅当有意保留 Private 时，VPS 才需要可读取该包的 PAT (classic)，最小权限 `read:packages`。交互输入避免写入命令历史：

```bash
read -rsp 'GHCR read token: ' GHCR_TOKEN; echo
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u Inklazy --password-stdin
unset GHCR_TOKEN
```

这不是 CI 的认证方式。不要将 token 写入仓库、Compose 或 Dockerfile。

### Debian 13 VPS 首次部署

先安装 Docker Engine 和 Docker Compose Plugin。Docker 官方安装完成后，确认：

```bash
docker --version
docker compose version
```

创建 Compose 配置目录和持久化数据目录。容器使用 Node 官方镜像的 `node` 用户（UID 1000），因此数据目录必须允许 UID 1000 写入：

```bash
sudo mkdir -p /opt/leave-system
sudo mkdir -p /opt/leave-system-data
sudo chown -R 1000:1000 /opt/leave-system-data
```

把仓库中的 `compose.yaml` 上传或下载到 `/opt/leave-system/compose.yaml`。如果仓库默认分支是 `main` 且仓库公开，可直接执行：

```bash
sudo curl -fsSLo /opt/leave-system/compose.yaml \
  https://raw.githubusercontent.com/Inklazy/DZGC-Leave-System/main/compose.yaml
```

启动：

```bash
cd /opt/leave-system
docker compose pull
docker compose up -d
docker compose ps
docker compose logs -f leave-system
```

`/opt/leave-system-data` 会挂载到容器内 `/app/data`。运行后生成或更新的文件为：

```text
/opt/leave-system-data/applications.json
/opt/leave-system-data/user-contexts.json
```

容器删除、升级或重建不会删除这两个文件。迁移 VPS 时必须备份整个 `/opt/leave-system-data` 目录。


## 二、VPS 本地构建（备用）

仅当 GitHub Actions / GHCR 不可用时使用。仓库中的 `compose.vps-build.yaml`。它与 `compose.yaml` 同时使用时，会将镜像改为在 VPS 本机构建的 `dzgc-leave-system:local`，数据卷、端口和 Caddy 配置保持不变。

### 方式 A：VPS 可以访问 GitHub

首次部署：

```bash
sudo apt-get update
sudo apt-get install -y git
sudo mkdir -p /opt/leave-system-data
sudo chown -R 1000:1000 /opt/leave-system-data
sudo git clone https://github.com/Inklazy/DZGC-Leave-System.git /opt/leave-system
cd /opt/leave-system
sudo docker compose -f compose.yaml -f compose.vps-build.yaml build --pull
sudo docker compose -f compose.yaml -f compose.vps-build.yaml up -d --no-build
sudo docker compose -f compose.yaml -f compose.vps-build.yaml ps
```

更新：

```bash
cd /opt/leave-system
sudo git pull --ff-only origin main
sudo docker compose -f compose.yaml -f compose.vps-build.yaml build --pull
sudo docker compose -f compose.yaml -f compose.vps-build.yaml up -d --no-build
sudo docker image prune -f
```

### 方式 B：不从 VPS 访问 GitHub

在 Windows PowerShell 的项目根目录执行：

```powershell
git archive --format=tar.gz --output=leave-system-source.tar.gz main
scp .\leave-system-source.tar.gz root@你的_VPS_IP:/tmp/
```

若使用 WinSCP，只需上传 `leave-system-source.tar.gz` 到 VPS 的 `/tmp/` 目录。VPS 执行：

```bash
sudo mkdir -p /opt/leave-system
sudo mkdir -p /opt/leave-system-data
sudo chown -R 1000:1000 /opt/leave-system-data
sudo tar -xzf /tmp/leave-system-source.tar.gz -C /opt/leave-system
cd /opt/leave-system
sudo docker compose -f compose.yaml -f compose.vps-build.yaml build --pull
sudo docker compose -f compose.yaml -f compose.vps-build.yaml up -d --no-build
```

更新时重新打包、上传、解压并执行构建和启动命令。不要删除或覆盖 `/opt/leave-system-data`。


## 三、Caddy 配置

Compose 只发布 `127.0.0.1:8123`，端口不会暴露到公网。保留以下 Caddy 配置即可：

```caddyfile
:80 {
    reverse_proxy 127.0.0.1:8123
}
```

检查并重载 Caddy：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

网络链路为：

```text
Internet -> Caddy :80 -> 127.0.0.1:8123 -> Docker leave-system -> Node :8123
```

## 四、GHCR 日常更新

本地代码提交并推送后，等待 GitHub Actions 成功。VPS 更新只需要：

```bash
cd /opt/leave-system
docker compose pull
docker compose up -d
docker image prune -f
```

查看当前运行版本：

```bash
docker inspect leave-system --format '{{.Config.Image}}'
docker compose ps
```

## 五、GHCR 回滚

GitHub Actions 为 main / v* 发布生成 `sha-<commit-short-sha>` 标签。将 `/opt/leave-system/compose.yaml` 的镜像行改为已知可用版本，例如：

```yaml
image: ghcr.io/inklazy/dzgc-leave-system:sha-abcdef1
```

然后重新拉取并启动：

```bash
cd /opt/leave-system
docker compose pull
docker compose up -d
```

回滚不会影响 `/opt/leave-system-data` 中的申请记录。

## 六、上线检查

```bash
curl -I http://127.0.0.1:8123/index.html
docker compose ps
docker compose logs --tail=100 leave-system
```

再从浏览器验证登录、提交申请、已通过记录、详情页，以及退出登录后重新登录记录仍存在。

从旧本地构建切换到 GHCR 时，更新 compose.yaml 镜像地址后只用 `docker compose pull` 和 `docker compose up -d`，不要再附加本地构建 override；数据挂载不变。日常 pull 只更新镜像，不会更新 compose.yaml；配置变更须单独审阅同步并保留 `.env`。回滚前建议备份数据；镜像回滚不会自动回滚数据格式。
