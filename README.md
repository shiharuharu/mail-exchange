# Mail Exchange

基于规则的邮件自动转发系统，支持 IMAP 监听和 SMTP 转发。

## 功能

- 监听 IMAP 邮箱的新邮件
- 根据邮件标题中的标签匹配转发规则
- 自动转发到指定收件人列表（并行发送，独立追踪）
- 转发完成后向原发件人发送通知邮件（含每个收件人状态）
- 发件人白名单，防止垃圾邮件攻击
- Web 界面查看转发任务状态
- 防止重启后重复转发

## 快速开始

### Docker 部署（推荐）

```bash
# 1. 复制配置文件
cp config.example.jsonc config.jsonc

# 2. 编辑配置
vim config.jsonc

# 3. 构建并启动
./docker-build.sh
docker compose up -d

# 4. 查看日志
docker compose logs -f
```

### 本地运行

```bash
# 安装依赖
bun install

# 开发模式
bun run dev

# 编译
bun run build

# 运行
./dist/mail-exchange
```

## 配置说明

编辑 `config.jsonc`：

```jsonc
{
  "imap": {
    "user": "exchange@example.com",
    "password": "your-password",
    "host": "imap.example.com",
    "port": 993,
    "tls": true
  },
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "secure": false,
    "auth": {
      "user": "exchange@example.com",
      "pass": "your-password"
    }
  },
  "rules": [
    {
      "tag": "[PHOTO]",
      "recipients": ["user1@example.com", "user2@example.com"]
    }
  ],
  "webPort": 3000,

  // 可选配置
  "forwardPrefix": "[Fwd]",  // 转发邮件标题前缀，不配置则无前缀
  "allowedSenders": ["@example.com", "admin@company.com"]  // 发件人白名单
}
```

### 配置项说明

| 配置项 | 必填 | 说明 |
|--------|------|------|
| `imap` | ✓ | IMAP 邮箱配置，用于接收邮件 |
| `smtp` | ✓ | SMTP 配置，用于发送转发邮件 |
| `rules` | ✓ | 转发规则列表 |
| `rules[].tag` | ✓ | 邮件标题中需要包含的标签（不区分大小写） |
| `rules[].recipients` | ✓ | 匹配后转发到的邮箱列表 |
| `webPort` | ✓ | Web 界面端口 |
| `forwardPrefix` | | 转发邮件标题前缀，不配置则保持原标题 |
| `allowedSenders` | | 发件人白名单，支持邮箱或域名，不配置则允许所有 |

## 使用方式

1. 发送邮件到配置的 IMAP 邮箱
2. 邮件标题包含规则中的标签，如 `[PHOTO] 订单照片`
3. 系统自动转发到对应收件人
4. 原发件人收到转发结果通知（含每个收件人的发送状态）

## 转发通知邮件

转发完成后，原发件人会收到一封通知邮件，包含：
- 转发状态（成功/部分失败）
- 统计数据（总数/成功/失败）
- 每个收件人的发送结果表格
- 失败原因（如有）

## Web 界面

访问 `http://localhost:3000` 查看：
- 转发任务列表
- 成功/失败统计
- 匹配的标签和收件人

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CONFIG_PATH` | 配置文件路径 | `./config.jsonc` |
| `DATA_DIR` | 数据目录（日志、UID记录） | `.` |

## 数据文件

- `mail-exchange.log` - 运行日志
- `.forwarded-uids` - 已转发邮件 UID 记录（防止重复转发）

## 跨平台编译

```bash
bun run build:linux-x64
bun run build:linux-arm64
bun run build:darwin-x64
bun run build:darwin-arm64
bun run build:windows-x64
bun run build:all
```

## License

MIT
