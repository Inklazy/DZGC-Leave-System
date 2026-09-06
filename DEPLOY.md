# Docker 部署指南：VPS 本机构建或 GHCR

项目支持两条 Docker 部署路线。两条路线都不需要 VPS 安装 Node.js 或运行 systemd，且都将请假记录保存到 VPS 的 `/opt/leave-system-data`。

1. **VPS 本机构建（推荐）**：VPS 使用项目源码和 Dockerfile 构建镜像，不依赖 GitHub Actions、GHCR 或 GitHub Packages。
2. **GHCR 拉取镜像（可选）**：GitHub Actions 构建镜像，VPS 只拉取镜像。

如果 GitHub Actions 或 GHCR 无法使用，直接使用第一条路线。

镜像地址：

```text
ghcr.io/zekty/dzgc-leave-system:latest
```

## 一、VPS 本机构建（推荐）

仓库中新增了 `compose.vps-build.yaml`。它与 `compose.yaml` 同时使用时，会将镜像改为在 VPS 本机构建的 `dzgc-leave-system:local`，数据卷、端口和 Caddy 配置保持不变。

### 方式 A：VPS 可以访问 GitHub

首次部署：

```bash
sudo apt-get update
sudo apt-get install -y git
sudo mkdir -p /opt/leave-system-data
sudo chown -R 1000:1000 /opt/leave-system-data
sudo git clone https://github.com/ZekTy/DZGC-Leave-System.git /opt/leave-system
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

## 二、GHCR 镜像部署（可选）

本地项目必须先位于 Git 仓库中，并关联到：

```text
https://github.com/ZekTy/DZGC-Leave-System.git
```

将 Docker 相关文件提交并推送。GitHub Actions 会自动构建镜像：

```bash
git add Dockerfile .dockerignore compose.yaml .gitignore .github scripts/serve-live-copy.mjs DEPLOY.md
git commit -m "Add Docker and GHCR deployment"
git push
```

推送默认分支后会发布两个常用镜像标签：

```text
ghcr.io/zekty/dzgc-leave-system:latest
ghcr.io/zekty/dzgc-leave-system:sha-<commit-short-sha>
```

推送形如 `v1.0.0` 的 Git tag 时，还会发布：

```text
ghcr.io/zekty/dzgc-leave-system:v1.0.0
```

首次推送后，到 GitHub 仓库的 Actions 页面等待工作流 `Build and publish Docker image` 成功。

## 三、GHCR 可见性和登录

GitHub Actions 使用内置的 `GITHUB_TOKEN` 推送镜像，不需要把 PAT 写进仓库。

如果希望 VPS 无需登录就能拉取镜像，到 GitHub 仓库对应的 Packages 页面，将 `dzgc-leave-system` 包的可见性设置为 Public。

若保持 Private，则 VPS 首次拉取前需要创建一个仅有 `read:packages` 权限的 GitHub Personal Access Token，并执行：

```bash
echo '你的_GHCR_PAT' | docker login ghcr.io -u ZekTy --password-stdin
```

不要把 PAT 写入 `compose.yaml`、Dockerfile 或 Git 仓库。

## 四、GHCR 路线的 Debian 13 VPS 首次部署

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
curl -fsSLo /opt/leave-system/compose.yaml \
  https://raw.githubusercontent.com/ZekTy/DZGC-Leave-System/main/compose.yaml
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

## 五、Caddy 配置

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

## 六、GHCR 日常更新

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

## 七、GHCR 回滚

GitHub Actions 为每次推送生成 `sha-<commit-short-sha>` 标签。将 `/opt/leave-system/compose.yaml` 的镜像行改为已知可用版本，例如：

```yaml
image: ghcr.io/zekty/dzgc-leave-system:sha-abcdef1
```

然后重新拉取并启动：

```bash
cd /opt/leave-system
docker compose pull
docker compose up -d
```

回滚不会影响 `/opt/leave-system-data` 中的申请记录。

## 八、上线检查

```bash
curl -I http://127.0.0.1:8123/index.html
docker compose ps
docker compose logs --tail=100 leave-system
```

再从浏览器验证登录、提交申请、已通过记录、详情页，以及退出登录后重新登录记录仍存在。
