# 大二进制资产清单

本仓库只跟踪**源码 + 文档 + 工具脚本**。下表资产因体积未纳入版本控制
（GitHub 单文件硬上限 100 MB，仓库建议 < 1 GB）。

## 一览

| 路径 | 体积 | 类型 | 获取方式 | 必需性 |
|---|---|---|---|---|
| `web/human/model/mmm_v6_soma_q8h.onnx` | 231.4 MB | ONNX 权重 | `node tools/fetch_hf_model.mjs q8h` | 数字人动作推理必需 |
| `web/sog/mm_floor1_clean.sog` | 92.6 MB | SOG 点云 | 资产提供方 | 一层场景必需 |
| `web/sog/mm_floor3_clean.sog` | 27.9 MB | SOG 点云 | 资产提供方 | 三层场景必需 |
| `web/media/test.mp4` | 94.4 MB | 演示视频 | 资产提供方 | 贴花演示用 |
| `web/human/vendor/ort/*.wasm` | 52.5 MB | ONNX Runtime Web | `npm i onnxruntime-web` | WebGPU 推理必需 |

被忽略的其余路径：

| 路径 | 说明 |
|---|---|
| `.verify-profile/` | Chrome 自动化用户数据（含大量缓存，数十 GB） |
| `shots/` | 截图产物，可由 `tools/` 脚本重新生成 |
| `runtime/` | 离线 Python 运行时，`start.bat` 可自动下载 |
| `tools/*.png` `tools/*.log` | 诊断截图与日志 |
| `web/sog/floor{1,3}/data/` | SOG 内部的 mesh 分片（随主 SOG 文件分发） |

## 一键获取

```bash
# ONNX 动作模型（q8 量化，231MB；脚本内置 hf-mirror 镜像 + 断点续传）
node tools/fetch_hf_model.mjs q8h

# 精度更高的 fp16 版本（约 380MB）
node tools/fetch_hf_model.mjs fp16
```

`fetch_hf_model.mjs` 支持断点续传（HTTP Range）、重定向跟随、60s 空闲超时。
`download_model.mjs` 为旧源（repalash.com）分片下载版，失败可重跑，已落盘的 shard 会跳过。

## 关于 Git LFS

若希望这些资产随仓库分发（而非按需下载），可启用 Git LFS：

```bash
git lfs install
git lfs track "web/sog/*.sog" "web/media/*.mp4" "web/human/model/*.onnx"
git add .gitattributes
git commit -m "chore: 用 LFS 跟踪大二进制资产"
```

本机已安装 `git-lfs 3.2.0`。注意 LFS 对象同样计入仓库配额（GitHub 个人账号
免费额度 10 GB / 10 GB 带宽），且 clone 时需 `git lfs pull` 才会真正下载。

## 校验

```bash
# 检查待提交内容中是否有超过 50MB 的文件（应为空）
git ls-files -o --exclude-standard -z | xargs -0 -I{} stat -c '%s {}' \
  | awk '$1 > 52428800 {printf "%.1f MB %s\n", $1/1048576, $2}'

# 统计仓库实际跟踪体积
git ls-files -o --exclude-standard -z | xargs -0 -I{} stat -c '%s' {} \
  | awk '{s+=$1} END {printf "%.2f MB / %d 文件\n", s/1048576, NR}'
```
