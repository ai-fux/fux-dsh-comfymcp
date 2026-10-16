# dsh-comfymcp 閮ㄧ讲鏂囨。

> 鐗堟湰 0.2.1锛堣凯浠ｅ垎鏀?`dev-snapshot-20261013-0.2.1`锛涗笂涓€绋冲畾鍒嗘敮 `snapshot-0.2.0`锛壜?鏇存柊鏃ユ湡 2026-10-13
> 閰嶅鏂囨。锛歔鎿嶄綔鎵嬪唽](operations.md) 路 [鍗忚璇存槑](protocol.md) 路 [杩唬璁板綍](roadmap.md) 路 [鎬昏 README](../README.md)

## 0. 浼犺緭鏂瑰紡锛坴0.2.1锛?

| 妯″紡 | 浼犺緭 | 璇存槑 |
| --- | --- | --- |
| 鍐呯疆鏈嶅姟锛坄embeddedServer=true`锛?| stdio | 鎻掍欢鑷甫 comfy-mcp-server锛堥殢鏈虹鍙ｏ級+ 鏈湴 stdio 瀹夸富锛涘崟鏈烘帹鑽愶紝鏃犻渶閰嶇疆绔偣 |
| 杩滅▼锛坄embeddedServer=false`锛?| **Streamable HTTP** | 鐩存帴 POST JSON-RPC 鍒般€屾湇鍔＄鐐广€嶏紙鍗曠鐐癸紝鍏煎 `application/json` 涓?`text/event-stream` 鍝嶅簲锛夛紝娌跨敤 `Mcp-Session-Id` 浼氳瘽锛涘彲閫夈€岃闂护鐗屻€嶄綔涓?`Authorization: Bearer` |

瑕佺偣锛?

- **杩滅▼妯″紡涓嶅啀 spawn 鏈湴 stdio 瀹夸富**锛屼篃涓嶅啀瑕佹眰 `hostEntry`锛堟鍓嶈繙绋嬩篃鍥犲涓诲叆鍙ｇ己澶辫€屾姤閿欙級銆?
- 宸ュ叿鍚嶅吋瀹癸細鎻掍欢鍐呴儴浠嶇敤瀹夸富宸ュ叿鍚嶏紙`connection_status` / `list_remote_tools` / `call_remote_tool` / `fetch_artifacts`锛夛紝杩滅▼妯″紡涓嬬敱闂ㄩ潰缈昏瘧鎴愬師鐢熷伐鍏凤紙`server_info` / `tools/list` / `tools/call` / `fetch_outputs`锛夛紝涓婂眰涓庤繍琛岄摼璺棤鎰熴€?
- 鍒囨崲妯″紡锛屾垨淇敼绔偣/璁块棶浠ょ墝鍚庯紝杩炴帴绔嬪嵆鎸夋柊閰嶇疆閲嶅缓锛堟棤闇€閲嶅惎 DSH锛夈€?
- 蹇€熻嚜妫€锛歚node scripts/verify-remote-http.mjs`锛堣捣鐪熷疄鏈嶅姟绔?鈫?杩滅▼鐩磋繛 鈫?鎺㈡祴 / 宸ュ叿鐩綍 / 杩滅▼璋冪敤锛夈€?

## 1. 鏋舵瀯鎬昏

```
澶фā鍨嬶紙Agent 浼氳瘽锛?
   鈹? comfymcp_* 宸ュ叿璋冪敤 / 缁撴瀯鍖栬〃鍗曪紙ask-user-question锛?
   鈻?
dsh-comfymcp-client锛圖SH 鎻掍欢锛岀函 JS 鏃犳瀯寤猴級
   鈹? 銆愯繙绋嬫ā寮忋€慚CP Streamable HTTP锛堝崟绔偣 POST JSON-RPC锛屽吋瀹?SSE锛?
   鈹? 銆愬唴缃ā寮忋€憇pawn stdio 鈫?MCP 瀹夸富 fux-comfymcp-host.mjs锛團UX runtime + @fux-mcp/comfy-client锛?
   鈻?
comfy-mcp-server 鍙傝€冩湇鍔＄锛圢ode锛屽彲閰?mock / stdio 涓ょ鍚庣锛?
   鈹? mock锛氬唴缃?13 宸ュ叿绂荤嚎鑱旇皟锛屽嚭 PNG
   鈹? stdio锛歴pawn fux-comfyui-mcp.mjs锛圢ode锛屼粎 HTTP 璁块棶 ComfyUI锛?
   鈻?
ComfyUI锛?8000锛岀敤鎴疯嚜澶囷紝.venv Python 3.12锛?
   鈹斺攢 custom_nodes/comfyui-unload-model锛堝嵏杞借妭鐐癸紝鏃?pip 渚濊禆锛?
```

绔彛涓€瑙堬細

| 绔彛 | 褰掑睘 | 璇存槑 |
| --- | --- | --- |
| 13188 | DSH Web GUI | 娴忚鍣ㄥ叆鍙ｏ紙鍚缃〉銆佷骇鐗╁崱锛?|
| 18800 | comfy-mcp 鏈嶅姟绔?| MCP Streamable HTTP锛坄/mcp`锛?|
| 8188 | ComfyUI | 浠?comfy-mcp 鐨?stdio 鍚庣璁块棶 |

## 2. 鍓嶇疆鏉′欢

| 椤?| 瑕佹眰 | 鏈満瀹炴祴 |
| --- | --- | --- |
| Node.js | >= 20 | v22.21.0 |
| pnpm | >= 10 | 11.13.0 |
| DSH | Web profile 姝ｅ父鍚姩 | GUI :13188 |
| ComfyUI | 鐪熷疄妯″紡鎵嶉渶瑕侊紝:8188 | v0.39.2 杩愯涓?|
| Python | 浠?ComfyUI 鑷韩 `.venv` 闇€瑕侊紙3.12锛?| 閾捐矾鏈韩闆?Python 渚濊禆 |
| 鍗歌浇鑺傜偣 | `custom_nodes/comfyui-unload-model`锛堝彲閫夛紝缂哄け浠呭奖鍝嶈嚜鍔ㄥ嵏杞斤級 | 宸茶骞跺凡鍔犺浇 |

## 3. 瀹夎姝ラ

浠ヤ笅鍛戒护鍧囧湪椤圭洰鏍?`F:\AgentWorkplace\dsh\dsh-13188-comfymcp\projects\dsh-comfymcp` 鎵ц銆?

### 3.0 涓ょ閮ㄧ讲褰㈡€侊紙鍏堥€変竴涓級

| 褰㈡€?| 璇存槑 | 閫傚悎 |
| --- | --- | --- |
| **鍐呭祵锛堥粯璁わ紝鎺ㄨ崘鍗曟満锛?* | comfy-mcp 鏈嶅姟绔敱 DSH 鎻掍欢**鑷姩鎷夎捣**锛氶殢鏈虹┖闂茬鍙ｃ€侀殢 DSH 鍚仠銆佹棤闇€浠讳綍鎵嬪姩鎿嶄綔锛汣omfyUI 鍙湪鏈満鎴栧眬鍩熺綉浠绘剰涓绘満锛堝悗绔粎璧?HTTP锛?| 鏈満寮€鍙?鍗曚汉浣跨敤 |
| **澶栫疆** | comfy-mcp 鏈嶅姟绔寜 3.2 鍗曠嫭鍚姩锛涜缃〉/琛岄厤缃叧闂唴宓屽紑鍏筹紝endpoint 鎸囧悜璇ユ湇鍔?| 澶氭秷璐硅€呭叡浜€佺嫭绔嬬敓鍛藉懆鏈熴€侀儴缃插湪鏈嶅姟鍣ㄤ富鏈?|

鍐呭祵妯″紡鐨勯粯璁ら厤缃凡鍐欏叆琛岄厤缃紙`embeddedServer: true` + stdio 鍚庣鎸囧悜
鍏勫紵椤圭洰 `fux-comfyui-mcp.mjs`锛夛紱**comfy-mcp-server 绋嬪簭宸插唴缃湪鎻掍欢鍖呭唴**
锛坄vendor/comfy-mcp-server.mjs`锛宔sbuild 鍗曟枃浠堕浂渚濊禆鎵撳寘锛夛紝閮ㄧ讲鏃舵棤闇€鍏冲績鍏惰矾寰勶紝
env `DSH_COMFYMCP_SERVER_ENTRY` 鎴栬鐩栧眰 `serverEntry` 鍙樉寮忚鐩栥€?
ComfyUI 鏈嶅姟鍦板潃鍙湪璁剧疆椤碉紙鍐呯疆妯″紡锛夌洿鎺ラ厤缃紙`comfyuiUrl`锛岄粯璁?
`http://127.0.0.1:8188`锛屼繚瀛樺悗鑷姩閲嶅惎鍐呯疆鏈嶅姟锛夈€侰omfyUI 鍘熺増鏈嶅姟鍗冲彲锛屾棤闇€鍦?
ComfyUI 鍐呰浠讳綍 MCP 缁勪欢锛堝彲閫?`comfyui-unload-model` 浠呯敤浜庤繍琛屽悗閲婃斁鏄惧瓨锛夈€?

### 3.1 瀹夎浠撳唴渚濊禆骞惰嚜妫€

```powershell
pnpm install
pnpm test                                              # 涓夊眰 vitest 鍏ㄧ豢
node comfy-mcp-server/bin/comfy-mcp-server.mjs --selftest
node mcp/bin/fux-comfymcp-host.mjs --selftest
```

### 3.2 鍚姩 comfy-mcp 鏈嶅姟绔紙浠呭缃舰鎬侀渶瑕侊級

**绂荤嚎鑱旇皟锛坢ock 鍚庣锛屽嚭 PNG锛?*锛?

```powershell
$env:COMFY_MCP_BACKEND='mock'; $env:COMFY_MCP_SERVER_PORT='18800'
node comfy-mcp-server/bin/comfy-mcp-server.mjs
```

**鐪熷疄妯″紡锛坰tdio 鍚庣锛屾帴杩愯涓殑 ComfyUI :8188锛?*锛?

```powershell
$env:COMFY_MCP_BACKEND='stdio'
$env:COMFY_MCP_SERVER_PORT='18800'
$env:COMFY_MCP_BACKEND_CMD='node'
$env:COMFY_MCP_BACKEND_ARGS='F:\AgentWorkplace\dsh\dsh-1-comfy-p\projects\dsh-comfyui\mcp\bin\fux-comfyui-mcp.mjs'
node comfy-mcp-server/bin/comfy-mcp-server.mjs
```

楠岃瘉锛歚Invoke-WebRequest http://127.0.0.1:18800/mcp -Method Options -UseBasicParsing` 杩斿洖 2xx/405 鍧囪涓哄瓨娲汇€?

### 3.3 鎸傝浇 DSH 鎻掍欢

鍦?DSH 浼氳瘽鍐呮墽琛岋紙鏈幆澧冪敱 Agent 浠ｆ搷浣滐級锛?

```
plugin_manager remove_bundle dsh-comfymcp-client        # 鑻ュ凡鎸傝浇
plugin_manager install_bundle <椤圭洰>\plugins\dsh-comfymcp-client
```

### 3.4 閲嶅惎 DSH锛堝繀椤伙級

瀹夸富杩涚▼鎸?URL 缂撳瓨妯″潡璁板綍涓庣敓鎴愬揩鐓э紝**杩涚▼鍐呬笉鍒锋柊**锛堝畼鏂硅涔夛細
*"replacing an installed package requires restart to load a fresh JavaScript module generation"*锛夈€?
浠讳綍鎻掍欢浠ｇ爜鏀瑰姩锛圚ost 鍗婂尯锛夐兘瑕?`install_bundle` + 閲嶅惎 DSH 鎵嶇敓鏁堛€?

> 缁忛獙锛氭敼浜嗕唬鐮佷絾鍚姩浠嶆姤鏃ч敊璇殑鍫嗘爤琛屽彿锛屽厛鎬€鐤戝揩鐓у喕缁擄紝閲嶅惎涓€娆″啀鐪嬨€?

### 3.5 楠岃瘉婵€娲?

1. 鍚姩鏃ュ織**鏃?* `1 entry did not activate`锛涚◢鍚庡嚭鐜?
   `panel channel /comfymcp ready (attempts=N)`锛堥潰鏉块€氶亾鍦?webServer 灏辩华鍚庤嚜鍔ㄦ寕杞斤紝
   N>1 灞炴甯糕€斺€攚ebServer 寮傛钀戒綅锛屾彃浠跺唴缃氨缁噸璇曪紝鏈€闀?2 鍒嗛挓锛夈€?
2. DSH Web 鈫?**璁剧疆 鈫?ComfyUI MCP** 鍑虹幇璁剧疆椤碉紙杩炴帴鐘舵€佺偣銆佷笁涓垎鍖哄崱鐗囷級銆?
3. 浼氳瘽鍐?Agent 璋?`comfymcp_status` 鈫?`ok: true`锛沵ock 妯″紡 `unload.available: true`銆?

## 4. 閰嶇疆鍙傝€?

### 4.1 灞傚簭锛堥珮 鈫?浣庯級

```
鐜鍙橀噺锛圖SH_COMFYMCP_* / COMFY_MCP_*锛?
  > DSH 琛岄厤缃紙cordis.patch.yml 鐨?dsh-comfymcp-client 琛岋級
  > 瑕嗙洊鏂囦欢 $DSH_HOME/comfymcp/config-overlay.json锛堣缃〉銆屼繚瀛橀厤缃€嶅啓鍏ワ紝鍘熷瓙鍐欙級
  > 鍐呯疆榛樿鍊?
```

### 4.2 閿綅

| 閿?| 榛樿 | 璇存槑 |
| --- | --- | --- |
| `DSH_COMFYMCP_HOST_ENTRY` | 椤圭洰鍐?`mcp/bin/fux-comfymcp-host.mjs` | DSH 鎻掍欢 spawn 鐨勫涓诲叆鍙?|
| `COMFY_MCP_ENDPOINT` | `http://127.0.0.1:18800/mcp` | comfy-mcp 鏈嶅姟绔偣 |
| `COMFY_MCP_SERVER_PORT` | 18800 | comfy-mcp 鏈嶅姟绔嚜韬洃鍚?|
| `COMFY_MCP_BACKEND` | `mock` | `mock` \| `stdio` |
| `COMFY_MCP_BACKEND_CMD` / `_ARGS` | 鈥?| stdio 鍚庣鍚姩鍛戒护锛堣 3.2锛?|
| `DSH_COMFYUI_URL` | `http://127.0.0.1:8188` | 鍏勫紵鍚庣鐢ㄧ殑 ComfyUI 鍦板潃锛堝叾 env 鏂囦欢绠＄悊锛?|
| 璁剧疆椤靛彲鏀?| endpoint / workflowDirs / saveSubdir / artifactsDir / hostEntry / autoUnloadModel / embeddedServer | 淇濆瓨杩涜鐩栨枃浠讹紝鍗虫椂鐢熸晥 |
| `embeddedServer` / `comfyuiUrl` / `embeddedBackend` / `embeddedBackendCommand` / `embeddedBackendArgs` / `serverEntry` | 琛岄厤缃 bundle patch | 鍐呭祵鏈嶅姟绔細寮€鍏?/ ComfyUI 鏈嶅姟鍦板潃锛堣缃〉鍙厤锛屼繚瀛樺嵆鐑噸鍚唴缃湇鍔★級/ `mock`\|`stdio` / 鍚庣鍛戒护 / 鍚庣鍙傛暟 / 鏈嶅姟鍏ュ彛锛堥粯璁ょ敤鎻掍欢鍐呯疆 vendor 鍖咃級锛沞nv 鍒悕 `DSH_COMFYMCP_SERVER_ENTRY` |

瀹屾暣绀轰緥瑙?[`config/comfymcp.env`](../config/comfymcp.env)銆?

## 5. 鐪熷疄妯″紡鍒囨崲涓?Python 渚ц姹?

1. ComfyUI 杩愯浜?:8188锛坄Invoke-WebRequest http://127.0.0.1:8188/system_stats`锛夈€?
2. 鍗歌浇鑺傜偣宸叉敞鍐岋紙`Invoke-WebRequest http://127.0.0.1:8188/object_info/UnloadAllModels`锛夛紱
   鏈畨瑁呮椂鍒?`custom_nodes/` 鏀惧叆 `comfyui-unload-model` 骞堕噸鍚?ComfyUI锛堟棤 pip 渚濊禆锛夈€?
3. comfy-mcp 鏈嶅姟绔寜 3.2 鐪熷疄妯″紡閲嶅惎銆?
4. `comfymcp_status` 鈫?`ok: true` 涓?`unload.available: true`銆?

Python 渚х粏鑺備笌楠岃瘉娓呭崟瑙?README銆孭ython 渚т緷璧栥€嶄竴鑺傗€斺€旈摼璺 Python 鍙湁
ComfyUI HTTP API 涓庡嵏杞借妭鐐逛袱涓帴瑙︾偣锛屾棤杩涚▼ spawn銆佹棤 pip install銆?

## 6. 鍗歌浇 / 鍥炴粴

```
plugin_manager remove_bundle dsh-comfymcp-client   # 绉婚櫎鎻掍欢锛堥殢鍚庨噸鍚?DSH锛?
```

瑕嗙洊鏂囦欢涓庝骇鐗╃洰褰曠嫭绔嬩簬鎻掍欢瀛樺湪锛屽闇€褰诲簳娓呯悊锛?
`$DSH_HOME/comfymcp/config-overlay.json`銆丏SH 鏁版嵁鐩綍涓?`comfymcp/artifacts`銆?

## 7. 閮ㄧ讲楠岃瘉娓呭崟锛圕heckList锛?

- [ ] `pnpm test` 鍏ㄧ豢锛涗袱涓?`--selftest` 閫氳繃
- [ ] comfy-mcp 鏈嶅姟绔瓨娲伙紙:18800锛?
- [ ] install_bundle 鎴愬姛涓?DSH 閲嶅惎鍚庢棤 activation 鎶ラ敊
- [ ] 鍚姩鏃ュ織鍑虹幇 `panel channel /comfymcp ready`
- [ ] 璁剧疆椤靛彲瑙佷笖銆屾祴璇曡繛鎺ャ€嶈繑鍥炲凡杩炴帴
- [ ] mock锛歚comfymcp_status` ok + unload available
- [ ] 锛堢湡瀹炴ā寮忥級object_info 鍛戒腑 UnloadAllModels + status unload available
- [ ] E2E锛氳嚜鐒惰瑷€ 鈫?琛ㄥ崟 鈫?杩愯 鈫?浜х墿鍗″洖鏄撅紙瑙佹搷浣滄墜鍐?搂2锛?
