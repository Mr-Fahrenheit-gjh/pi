# 系统路径排查

以下命令按问题选用，不是每次全部执行。先读 [代理工具 README](../../../../工具/代理分流管理/README.md) 了解生成、备份与检查的边界。

## 只读诊断

### 系统与活动服务

```sh
scutil --proxy
scutil --nwi
route -n get default
networksetup -listnetworkserviceorder
networksetup -listallnetworkservices
```

先将活动接口映射到网络服务名称，再查询该服务；服务名不一定是 Wi-Fi，TUN 开启时默认路由也未必是物理接口。

```sh
networksetup -getwebproxy '<服务名>'
networksetup -getsecurewebproxy '<服务名>'
networksetup -getsocksfirewallproxy '<服务名>'
networksetup -getproxybypassdomains '<服务名>'
pi-route status
```

从技能目录运行系统 URL 分流检查（只读、不访问这些 URL）：

```sh
python3 scripts/system-route.py https://www.bilibili.com/ https://i0.hdslb.com/ https://www.google.com/
```

`direct: true` 表示 CFNetwork 为该 URL 选择直接连接；`proxies` 列出系统选择的代理候选。它不观察真实浏览器连接，不覆盖应用显式代理、扩展、已有长连接或 TUN。对照域名以当前确实需要走代理的站点为准。

### PandaFan 的下一层

配置位于 `~/Library/Application Support/PandaFan/config.json`，它可能包含凭据。用本地 JSON 解析只输出：
- `runTimeState` 中存在的 `smart_route`、`tun_mode`、`defaultToProxy`、`applyCustomRulesInGlobal`、`set_proxy`。
- 当前服务规则中与目标域名有关的项及其顺序。缓存或订阅默认规则不等于运行内核规则。

字段可能随版本改变；缺少字段如实报告，通过当前受支持的状态／连接入口继续核实。运行状态或出口无证据时，结论停在已知层。不要输出整个配置或批量扫描浏览器会话、Cookie。

### 性能对照

对公开 URL 用同一地址、相近时刻、有超时的请求：

```sh
curl --noproxy '*' -L -o /dev/null -sS --max-time 20 \
  -w 'status=%{http_code} remote=%{remote_ip} connect=%{time_connect} first_byte=%{time_starttransfer} total=%{time_total}\n' '<URL>'
curl --noproxy '' -x '<从当前配置读取的HTTP代理地址>' -L -o /dev/null -sS --max-time 20 \
  -w 'status=%{http_code} remote=%{remote_ip} connect=%{time_connect} first_byte=%{time_starttransfer} total=%{time_total}\n' '<URL>'
```

curl 不自动证明浏览器系统分流；“直连”命令仍可能被 TUN 接管。本机代理测试也不证明境外出口。遇到登录、风控或不同状态码，不能直接比较为网络速度；视频卡顿需要实际媒体资源或播放证据。需要浏览器时先读 browser-harness 技能，登录态按 OpenCLI 入口处理。

## 定向修改与恢复

### 系统网站直连

1. 获取活动服务的原绕过列表与 `scutil --proxy` 快照。原始列表保存在工作区 `系统数据/代理分流管理/backups/<任务名>/`，作为恢复依据，不提交 Git。
2. 确定网页、API、图片、媒体等必要域名。给每个需要绕过的域名加入自身与 `*.<域名>`；保留原列表和其他代理开关。空列表必须正确识别，不能把命令的“无绕过域名”提示当域名。
3. 用参数数组（避免 shell 插值）运行 `networksetup -setproxybypassdomains <服务名> <完整合并后的列表...>`。若用户仅授权诊断，先请求修改确认；定向直连已获授权则无需重复询问。权限失败报告错误，sudo 或其他提权另行确认。
4. 回读，确认原例外无丢失，代理主机、端口和开关未改变；运行系统 URL 分流检查验证目标与对照。
5. 恢复时只撤销本任务新增项，保留后续其他任务加入的例外；若恢复后列表为空，按 networksetup 的 `Empty` 语法处理。PandaFan 重连、服务切换或规则重建后需重新核实，不承诺永久不变。

系统绕过不是 PandaFan TUN 规则。仍被接管时核实该层，避免通过关闭所有代理来解决单个网站问题。PandaFan 配置可能由运行程序覆盖；未经核实的直接 JSON 编辑不作为生效入口。

### 命令规则与后台副本

复用 `proxy-env` 与代理工具，不新建规则格式或第二份名单。

- 已有 shell source 块且只更新域名：先备份本任务涉及的配置与生成物，再改 `rules.yaml` 并 `pi-route render`。render 仅刷新项目生成物。
- 需要建立／修改 shell source 块：先取得 shell 修改授权，再按工具 README 的 `apply` 流程；apply 前不 render，否则备份失去原生成物。
- `check` 报后台副本漂移：对比是否由本任务引起，确认复制目标与内容后，先在工作区备份，再同步到 `~/.pi/agent/pi-web-proxy.env`，保持 0600。若工作区禁止目录外写入且没有明确例外授权，报告待同步并请求授权，不把检查失败改写成通过。
- 后台磁盘副本更新不等于 Pi Web 当前进程已加载。仅为分流文件变更不重启正式服务；确需重启时走原有确认与维护流程。
- 只处理本任务造成的漂移；原有问题如实记录，不为“全绿”扩大修改。

### 强制代理

`pi-route run proxy -- <命令>` 只表示将请求交给本机代理。现有工具拒绝非空 `always_proxy`，不能靠它表达“直连后缀中的这个站必须境外代理”。需要通过 PandaFan 受支持的域名规则入口执行；若入口、持久化或热加载方法未知，先核实，不能改历史 Clash 或猜内部 API。
