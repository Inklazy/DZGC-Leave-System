# DZGC Leave System

请假系统 Docker 服务器版。应用代理原站登录、验证码和页面接口，本地提交记录保存在 VPS 的 JSON 数据目录中。

## 架构

```text
GitHub push -> GitHub Actions -> GHCR image -> VPS docker compose pull -> Docker -> Caddy :80
```

镜像：

```text
ghcr.io/zekty/dzgc-leave-system:latest
```

运行端口为 `8123`，时区为 `Asia/Shanghai`。数据目录不进入镜像：

```text
VPS: /opt/leave-system-data
容器: /app/data
```

其中 `applications.json` 和 `user-contexts.json` 是请假记录和账号展示信息。不要删除 `/opt/leave-system-data`。

## VPS 首次部署

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

启动 Docker 版本并确认登录、提交、记录详情都正常：

```bash
cd /opt/leave-system
docker compose pull
docker compose up -d
docker compose ps
```

确认无误后删除旧 systemd 服务文件：

```bash
sudo rm -f /etc/systemd/system/leave-system.service
sudo systemctl daemon-reload
```

不要删除 `/opt/leave-system-data`。清理旧项目文件前先预览：

```bash
sudo find /opt/leave-system -mindepth 1 -maxdepth 1 ! -name compose.yaml -print
```

确认列表正确后才删除旧文件，保留 `compose.yaml`：

```bash
sudo find /opt/leave-system -mindepth 1 -maxdepth 1 ! -name compose.yaml -exec rm -rf -- {} +
```

## 日常更新

推送到 `main` 后，GitHub Actions 会自动测试、构建并发布新镜像。VPS 更新：

```bash
cd /opt/leave-system
docker compose pull
docker compose up -d
docker image prune -f
```

更新不会删除 `/opt/leave-system-data` 中的请假记录。

## 回滚

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
