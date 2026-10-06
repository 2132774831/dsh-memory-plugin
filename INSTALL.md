# 安装说明

## 一、装进去

```powershell
dsh plugin --profile desktop add "C:\Users\Administrator\Documents\deepseek-harness\default-workspace\dsh-local-memory"
```

> **路径要用绝对路径。** 用相对路径（如 `./dsh-local-memory`）会被解析成相对
> **profile 目录**，装出来是个指不到东西的死链接（这个坑我踩过）。

装完 **重启 dsh web**（关掉启动器窗口再重新双击），设置页会出现「**本地记忆**」。

### 为什么必须用 `dsh plugin add`

DSH 靠 `dsh.profile.bundles` 这个层堆栈决定加载哪些插件。`dsh plugin add` 是
`pnpm add` 的包装，装完后 DSH 会把「声明了 `dsh.bundle` 的依赖」并入层堆栈 ——
插件自带的 `cordis.patch.yml` 就是那时作为一层被应用的。

**手工把目录拷进 `node_modules` 不会被识别。**

---

## 二、验证装好了

重启后访问（**不带 token**）：

- `/dsh-local-memory/state` 返回 **401** → 路由已注册（401 是插件自己的信任栅栏，正常）
- 返回 **404** → 没装成功，或没重启

打开设置页应该看到「**本地记忆**」，里面能：

1. 看到记忆列表（一开始是空的）
2. 点「+ 新增记忆」写一条，保存后立刻出现在列表里
3. 编辑、删除那条记忆
4. 改下面的设置并「保存设置」

手动写一条试试，然后刷新页面——记忆还在，说明文件落盘成功。也可以直接打开

```
%USERPROFILE%\.dsh\dsh-local-memory.json
```

看文件内容。

---

## 三、让模型真的用起来

重启后新开一个对话，跟它说：

> 记住：这个项目的鉴权用的是轮询而不是 webhook，因为要避免公网回调

模型会调用 `memory_save`。然后**再开一个全新对话**，问：

> 我们鉴权是怎么设计的？

正常应该能看到模型调用 `memory_search`，并把那条记忆答出来 —— 这就是「跨对话记忆」。

---

## 四、环境要求

| 项 | 要求 |
|---|---|
| Node | **>= 20** |
| 平台 | DSH **web** profile |
| 运行时依赖 | **零** |
| 外部服务 / API key | **都不需要** |

---

## 五、装完请检查一次

如果你之前手工在 profile 的 `cordis.patch.yml` 里加过这个插件，而你又用了
`dsh plugin add`，**必须删掉手工那两行**，否则插件注册两次，设置页会出现两个
「本地记忆」面板。

---

## 六、卸载

```powershell
dsh plugin --profile desktop remove dsh-local-memory
```

**记忆文件不会被删**。想彻底清掉：

```powershell
Remove-Item "$env:USERPROFILE\.dsh\dsh-local-memory.json"
Remove-Item "$env:USERPROFILE\.dsh\dsh-local-memory-config.json"
```

---

## 七、排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 设置页没有「本地记忆」 | 没装成功 / 没重启 | 查 `/dsh-local-memory/state` 是不是 401 |
| 面板显示「读取失败」 | Host 半侧没起来 | 看 401/404；确认插件 enabled |
| 模型说「记忆库已关闭」 | 总开关关了 | 设置页打开「启用本地记忆」 |
| 记了但搜不到 | 关键词没对上 | 用 `memory_list` 看看实际存了什么；中文按二字组合匹配，查得具体些 |
| 记忆文件越来越大 | 条数没上限 | 调小「记忆条数上限」，或手动清理 |
| 项目标签不对 | 会话目录不在 git 里 | 正常回落到目录名；也可以关掉「自动打项目标签」 |
| 每轮变慢 | 不太可能（纯本地） | 记忆条数过多时调小「最多注入几条」 |
