# DZGC Leave System

请假系统 Docker 服务器版。应用代理原站登录、验证码和页面接口，本地提交记录保存在 VPS 的 JSON 数据目录中。

## 部署路线

```text
推荐：GitHub / 本地源码 -> VPS docker compose build -> Docker -> Caddy :80
可选：GitHub push -> GitHub Actions -> GHCR image -> VPS docker compose pull -> Docker -> Caddy :80
```

推荐路线完全不依赖 GitHub Actions 或 GHCR。VPS 在本机根据 `Dockerfile` 构建镜像，适合 Actions 或 GHCR 无法使用的情况。

GHCR 镜像路线仍保留为可选方案：

```text
ghcr.io/zekty/dzgc-leave-system:latest
```

运行端口为 `8123`，时区为 `Asia/Shanghai`。数据目录不进入镜像：

```text
VPS: /opt/leave-system-data
容器: /app/data
```

其中 `applications.json` 和 `user-contexts.json` 是请假记录和账号展示信息。不要删除 `/opt/leave-system-data`。

## VPS 本机构建部署（推荐）

确认 VPS 已安装 Docker Engine、Docker Compose Plugin 和 Git：

```bash
docker --version
docker compose version
git --version
```

创建持久化数据目录。请假记录始终放在这个目录，更新源码或重建容器都不会删除它：

```bash
sudo mkdir -p /opt/leave-system-data
sudo chown -R 1000:1000 /opt/leave-system-data
```

### 方式 A：VPS 可以访问 GitHub

首次部署时克隆源码：

```bash
sudo git clone https://github.com/ZekTy/DZGC-Leave-System.git /opt/leave-system
cd /opt/leave-system
sudo docker compose -f compose.yaml -f compose.vps-build.yaml build --pull
sudo docker compose -f compose.yaml -f compose.vps-build.yaml up -d --no-build
sudo docker compose -f compose.yaml -f compose.vps-build.yaml ps
```

日常更新只需在 VPS 执行：

```bash
cd /opt/leave-system
sudo git pull --ff-only origin main
sudo docker compose -f compose.yaml -f compose.vps-build.yaml build --pull
sudo docker compose -f compose.yaml -f compose.vps-build.yaml up -d --no-build
sudo docker image prune -f
```

### 方式 B：VPS 不能访问 GitHub

在 Windows 项目目录创建不含 `data/` 的源码包，再上传到 VPS。该包只包含 Git 已跟踪的项目文件：

```powershell
git archive --format=tar.gz --output=leave-system-source.tar.gz main
scp .\leave-system-source.tar.gz root@你的_VPS_IP:/tmp/
```

也可以用 WinSCP 上传 `leave-system-source.tar.gz` 到 VPS 的 `/tmp/` 目录。然后在 VPS 执行：

```bash
sudo mkdir -p /opt/leave-system
sudo tar -xzf /tmp/leave-system-source.tar.gz -C /opt/leave-system
cd /opt/leave-system
sudo docker compose -f compose.yaml -f compose.vps-build.yaml build --pull
sudo docker compose -f compose.yaml -f compose.vps-build.yaml up -d --no-build
```

后续更新时，重新创建并上传同名源码包，执行上述解压、构建、启动三条命令即可。不要上传或覆盖 `/opt/leave-system-data`。

## GHCR 镜像部署（可选）

确认 VPS 已安装 Docker Engine 和 Compose Plugin：

```bash
docker --version
docker compose version
```

创建目录并设置数据权限：

```bash
sudo mkdir -p /opt/leave-system
sudo mkdir -p /opt/leave-system-data
sudo chown -R 1000:1000 /opt/leave-system-data
```

下载 Compose 配置：

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
```

检查服务：

```bash
docker compose logs --tail=100 leave-system
curl -I http://127.0.0.1:8123/index.html
```

## Caddy

容器端口只绑定 VPS 本机。Caddy 保持以下配置：

```caddyfile
:80 {
    reverse_proxy 127.0.0.1:8123
}
```

配置后检查并重载：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## 从旧 Node/systemd 版本迁移

先停止旧服务：

```bash
sudo systemctl stop leave-system
sudo systemctl disable leave-system
```

若旧数据在 `/opt/leave-system/data`，先确认新目录为空，再复制：

```bash
sudo ls -lah /opt/leave-system/data
sudo ls -lah /opt/leave-system-data
sudo cp -a /opt/leave-system/data/. /opt/leave-system-data/
sudo chown -R 1000:1000 /opt/leave-system-data
```

使用 VPS 本机构建启动 Docker 版本，并确认登录、提交、记录详情都正常：

```bash
cd /opt/leave-system
sudo docker compose -f compose.yaml -f compose.vps-build.yaml build --pull
sudo docker compose -f compose.yaml -f compose.vps-build.yaml up -d --no-build
sudo docker compose -f compose.yaml -f compose.vps-build.yaml ps
```

确认无误后删除旧 systemd 服务文件：

```bash
sudo rm -f /etc/systemd/system/leave-system.service
sudo systemctl daemon-reload
```

不要删除 `/opt/leave-system-data`。VPS 本机构建路线需要保留 `/opt/leave-system` 中的源码，因此不要执行旧项目目录清理命令。

## GHCR 日常更新

推送到 `main` 后，GitHub Actions 会自动测试、构建并发布新镜像。VPS 更新：

```bash
cd /opt/leave-system
docker compose pull
docker compose up -d
docker image prune -f
```

更新不会删除 `/opt/leave-system-data` 中的请假记录。

## GHCR 回滚

每次提交还会生成 SHA 镜像，例如：

```text
ghcr.io/zekty/dzgc-leave-system:sha-abcdef1
```

将 `/opt/leave-system/compose.yaml` 中的镜像改成对应 SHA 后执行：

```bash
cd /opt/leave-system
docker compose pull
docker compose up -d
```

## GHCR 私有镜像

GitHub Actions 使用内置 `GITHUB_TOKEN` 推送镜像。如果 GHCR 包是 Private，VPS 首次拉取前登录：

```bash
echo '你的_GHCR_PAT' | docker login ghcr.io -u ZekTy --password-stdin
```

PAT 仅需 `read:packages` 权限，不能写入仓库文件。

详细说明见 [DEPLOY.md](DEPLOY.md)。
