# Mail Exchange

基于规则的邮件自动转发系统，支持 IMAP 监听和 SMTP 转发。

## 功能特性

- 📬 监听 IMAP 邮箱的新邮件
- 🏷️ 根据邮件标题中的标签匹配转发规则（不区分大小写）
- 📤 自动转发到指定收件人列表（并行发送，独立追踪）
- 📧 转发完成后向原发件人发送通知邮件（含每个收件人状态表格）
- 🔄 发送失败自动重试（可配置重试次数）
- 🛡️ 发件人白名单，防止垃圾邮件攻击
- 🌐 Web 界面查看转发任务状态
- 💾 基于 Message-ID 防止重复转发（重启安全）
- 📝 可配置日志等级

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
  // IMAP 配置
  "imap": {
    "user": "exchange@example.com",
    "password": "your-password",
    "host": "imap.example.com",
    "port": 993,
    "tls": true
  },

  // SMTP 配置
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "secure": false,
    "auth": {
      "user": "exchange@example.com",
      "pass": "your-password"
    }
  },

  // 转发规则
  "rules": [
    {
      "tag": "[PHOTO]",
      "recipients": ["user1@example.com", "user2@example.com"]
    },
    {
      "tag": "[INVOICE]",
      "recipients": ["finance@example.com"]
    }
  ],

  // Web 界面端口
  "webPort": 3000,

  // 可选配置
  "forwardPrefix": "[Fwd]",                              // 转发标题前缀
  "allowedSenders": ["@example.com", "admin@other.com"], // 发件人白名单
  "retryCount": 3,                                       // 发送失败重试次数
  "logLevel": "INFO"                                     // 日志等级
}
```

### 配置项说明

| 配置项 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `imap` | ✓ | - | IMAP 邮箱配置 |
| `smtp` | ✓ | - | SMTP 发送配置 |
| `rules` | ✓ | - | 转发规则列表 |
| `rules[].tag` | ✓ | - | 标题匹配标签（不区分大小写） |
| `rules[].recipients` | ✓ | - | 转发目标邮箱列表 |
| `webPort` | ✓ | - | Web 界面端口 |
| `forwardPrefix` | | 无 | 转发邮件标题前缀 |
| `allowedSenders` | | 允许所有 | 发件人白名单（邮箱或域名） |
| `retryCount` | | 3 | 发送失败重试次数 |
| `logLevel` | | INFO | 日志等级：DEBUG/INFO/WARN/ERROR |

## 使用方式

1. 发送邮件到配置的 IMAP 邮箱
2. 邮件标题包含规则中的标签，如 `订单照片 [PHOTO]`
3. 系统自动转发到对应收件人
4. 原发件人收到转发结果通知

## 日志输出

```
[INFO] New mail: "[TEST] 测试" from=user@example.com size=2KB attachments=1
[INFO] Forwarding from=user@example.com tag=[TEST] to=2 recipients
[INFO]   -> admin@example.com: OK
[WARN]   -> backup@example.com: RETRY 1/3 - Connection timeout
[INFO]   -> backup@example.com: OK (attempt 2)
[INFO] Forward completed: [TEST] 测试 - 2/2 success (1234ms)
```

## 转发通知邮件

转发完成后，原发件人会收到通知邮件：

- 顶部色条指示状态（绿色成功/橙色部分失败）
- 统计仪表盘（总数/成功/失败）
- 每个收件人的发送结果表格
- 失败原因详情

## Web 界面

访问 `http://localhost:3000` 查看：
- 转发任务列表
- 成功/失败统计
- 匹配的标签和收件人

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CONFIG_PATH` | 配置文件路径 | `./config.jsonc` |
| `DATA_DIR` | 数据目录 | `.` |

## 数据文件

| 文件 | 说明 |
|------|------|
| `mail-exchange.log` | 运行日志 |
| `.forwarded-ids` | 已转发邮件 Message-ID 记录 |

## 跨平台编译

```bash
bun run build              # 当前平台
bun run build:linux-x64    # Linux x64
bun run build:linux-arm64  # Linux ARM64
bun run build:darwin-x64   # macOS Intel
bun run build:darwin-arm64 # macOS Apple Silicon
bun run build:windows-x64  # Windows x64
bun run build:all          # 全部平台
```

## 项目结构

```
mail-exchange/
├── src/
│   ├── index.ts          # 主程序
│   └── reply-template.ts # 通知邮件模板
├── config.example.jsonc  # 配置示例
├── Dockerfile            # Docker 构建
├── docker-compose.yml    # Docker 编排
└── docker-build.sh       # 构建脚本
```

## License

MIT
