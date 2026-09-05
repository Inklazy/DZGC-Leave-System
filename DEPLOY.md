# Docker + GHCR 部署指南

本项目通过 GitHub Actions 自动构建 Docker 镜像并推送到 GitHub Container Registry（GHCR）。VPS 不需要安装 Node.js，也不需要运行 systemd 服务，只需拉取镜像并使用 Docker Compose 启动。

镜像地址：

```text
ghcr.io/zekty/dzgc-leave-system:latest
```

## 一、首次发布镜像

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

## 二、GHCR 可见性和登录

GitHub Actions 使用内置的 `GITHUB_TOKEN` 推送镜像，不需要把 PAT 写进仓库。

如果希望 VPS 无需登录就能拉取镜像，到 GitHub 仓库对应的 Packages 页面，将 `dzgc-leave-system` 包的可见性设置为 Public。

若保持 Private，则 VPS 首次拉取前需要创建一个仅有 `read:packages` 权限的 GitHub Personal Access Token，并执行：

```bash
echo '你的_GHCR_PAT' | docker login ghcr.io -u ZekTy --password-stdin
```

不要把 PAT 写入 `compose.yaml`、Dockerfile 或 Git 仓库。

## 三、Debian 13 VPS 首次部署

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

## 四、Caddy 配置

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

## 五、日常更新

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

## 六、回滚

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

## 七、上线检查

```bash
curl -I http://127.0.0.1:8123/index.html
docker compose ps
docker compose logs --tail=100 leave-system
```

再从浏览器验证登录、提交申请、已通过记录、详情页，以及退出登录后重新登录记录仍存在。
