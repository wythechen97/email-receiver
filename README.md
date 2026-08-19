# GMX 按需收件服务

本地 Node.js 服务。导入账号时为每个账号生成唯一 SOCKS5 session ID；不会轮询，也不会维护 IMAP 长连接。只有调用手动收件接口时，才会连接 `imap.gmx.net:993`，读取结束立即登出并关闭连接。

## 安装与启动

```bash
npm install
cp .env.example .env
npm start
```

服务只监听 `127.0.0.1`，不会暴露给局域网。

## Docker / NAS 部署

将整个项目目录放到 NAS，例如 `/volume1/docker/email-receiver`。数据目录必须与
`compose.yaml` 同级，容器会把它绑定挂载为 `/app/data`：账号配置、SQLite 数据库及 WAL
文件都始终保存在 NAS 的项目目录中，而不在容器可写层内。

```bash
cd /volume1/docker/email-receiver
cp .env.example .env
# 编辑 .env，填入 ACCOUNT_ENCRYPTION_KEY 和代理配置
docker compose up -d --build
```

无需预先创建 `data/`：Docker Compose 会在首次启动时自动创建项目同级的该目录。

打开 `http://<NAS-IP>:8787`。如 NAS 的 8787 端口已被占用，可将 `compose.yaml` 中的
`"8787:8787"` 改为例如 `"18087:8787"`，然后通过 `http://<NAS-IP>:18087` 访问。

常用维护命令：

```bash
docker compose logs -f
docker compose up -d --build
docker compose down   # 仅停止和删除容器，不会删除 ./data 中的数据
```

升级或重建容器前，请保留 `data/` 与 `.env`；其中的 `ACCOUNT_ENCRYPTION_KEY` 必须保持不变，
否则已有账号密码无法解密。

## 管理界面

启动后打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)，注册首个本地用户并登录。每个用户只能查看、添加和操作自己名下的 GMX 账号与邮件；登录会话通过同源 HttpOnly Cookie 保存。界面支持：

- 通过表单单个添加账号，或使用 `邮箱----IMAP 密码` 格式批量导入账号（也兼容 `邮箱 | IMAP 密码`）；
- 在 MAILBOX 中查看每个账号当前代理 Session 实际对外使用的公网出口 IP；
- 按账号更换代理出口（生成新的唯一 session）；
- 启用或停用账号；
- 点击“收取邮件”时才建立一次 IMAP 连接，完成后立即断开；
- 如果代理出口在 GMX TLS 建立前断开，单次手动收件会自动更换 session 并最多重试两次；
- 已拉取的邮件会持久化保存在本地 SQLite 数据库 `data/mail.sqlite`；再次打开邮箱时无需重新收件即可查看。
- 每封新收取邮件会保存对应的代理出口地址、端口和 Session 标识，并在详情中显示。
- 默认在隔离的 HTML frame 中预览富文本正文；纯文本邮件自动使用纯文本视图。

## 多用户与导入账号

不再使用 `LOCAL_API_TOKEN`。用户密码以 Node.js `scrypt` 哈希保存；GMX IMAP 密码仍使用
`ACCOUNT_ENCRYPTION_KEY` 以 AES-256-GCM 加密保存。若从旧版升级，首位注册用户会自动认领原有
未归属的邮箱和邮件，以避免数据丢失。

如需用脚本调用 API，先注册或登录并保存 Cookie：

```bash
curl -c cookies.txt -X POST http://127.0.0.1:8787/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"your-user","password":"your-login-password"}'
```

每次导入均会生成并持久化唯一的 `proxySessionId`，以自动构造代理用户名：

```text
USERNAME-zone-custom-region-US-session-{sessionId}-sessTime-20
```

```bash
curl -X POST http://127.0.0.1:8787/api/accounts/import \
  -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{
    "accounts": [
      { "email": "first@gmx.us", "password": "GMX_IMAP_PASSWORD_1" },
      { "email": "second@gmx.net", "password": "GMX_IMAP_PASSWORD_2" }
    ]
  }'
```

密码使用 `ACCOUNT_ENCRYPTION_KEY` 以 AES-256-GCM 加密后保存在 `data/accounts.json`；不要提交该目录或 `.env` 到版本控制。

## 手动收件

先调用 `GET /api/accounts` 获取账号 ID，然后按需调用：

```bash
curl -X POST "http://127.0.0.1:8787/api/accounts/<ACCOUNT_ID>/fetch" \
  -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{ "limit": 10 }'
```

此请求完成后连接立即关闭。服务没有定时器、轮询或 IMAP IDLE 连接。

## 开关账号

```bash
curl -X POST http://127.0.0.1:8787/api/accounts/<ACCOUNT_ID>/disable \
  -b cookies.txt
```

停用后手动收件会被拒绝。重新启用时将 `disable` 改为 `enable`。
