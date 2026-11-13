// Aurabot 多平台 · 聊天地址处理（P0 产出）
// 作用：实现 contracts.d.ts 的 AddressApi 四个函数，全仓库处理地址只许用这里，
//       禁止 split(':')、禁止 === / startsWith 直接比地址（见 docs/CONTRACTS.md 第三节）。
// 契约来源：src/gateway/contracts.d.ts 第 1 节；文字规则：docs/CONTRACTS.md §三。
// 形态说明（normalizeChatId 同时吃三种）：
//   旧写法（无平台段）   private:10001 / group:123        → 视为 qq:private:10001 / qq:group:123
//   新写法（有平台段）   qq:private:10001 / feishu:group:oc_x
//   带实例名（#）        qq#2:private:10001
//   内部后台会话         system:<名字>                     → 原样放行，不属于任何平台
// 写入侧铁规：一律写规范形态；旧数据不回写，读的时候换算。

/** 平台名：小写字母开头，后接小写字母/数字/-（见 contracts.d.ts Platform 注释） */
const PLATFORM_RE = /^[a-z][a-z0-9-]*$/;
/** 实例名：平台名，或 平台名#别名（别名用小写字母/数字/_/-） */
const INSTANCE_RE = /^([a-z][a-z0-9-]*)(?:#([a-z0-9_-]+))?$/;
const KINDS = new Set(['private', 'group']);

/** 把「实例名」拆成 { platform, alias }；不合法返回 null */
function parseInstance(instance) {
  const m = INSTANCE_RE.exec(instance);
  if (!m) return null;
  return { platform: m[1], alias: m[2] || '' };
}

/**
 * 任何形态 → 规范形态。
 * system:* 原样返回（内部后台会话不经过网关）；认不出返回 null；空串/非字符串返回 null。
 */
export function normalizeChatId(input) {
  if (typeof input !== 'string') return null;
  const s = input;
  if (!s) return null;
  // system:<名字> 原样放行；名字非空即可（不限定字符集，后台会话名由插件自己管）
  if (s.startsWith('system:')) return s.length > 'system:'.length ? s : null;
  const firstColon = s.indexOf(':');
  if (firstColon <= 0) return null; // 没有冒号、或冒号在开头 → 认不出
  const head = s.slice(0, firstColon);
  const rest = s.slice(firstColon + 1);
  // 形态判断：head 是 kind（旧写法）还是实例名（新写法）
  if (KINDS.has(head)) {
    // 旧写法 private:10001 / group:123 → 永久别名，换算成 qq 前缀；编号非空
    if (!rest) return null;
    return `qq:${s}`;
  }
  // 新写法 <实例>:<kind>:<编号>
  if (!parseInstance(head)) return null;
  const secondColon = rest.indexOf(':');
  if (secondColon <= 0) return null;
  const kind = rest.slice(0, secondColon);
  const id = rest.slice(secondColon + 1);
  if (!KINDS.has(kind) || !id) return null;
  return s; // head/kind/id 全合法，原样即规范形态（实例名与编号不再改写大小写等）
}

/**
 * 规范形态 → 拆开。
 * system:* 和认不出的返回 null。返回的 platform 是实例名 # 前的部分（默认平台名；
 * 实例可经配置把 adapter 另行指定，那个映射归网关管，这里保持纯函数不做配置查询）。
 */
export function parseChatId(input) {
  const norm = normalizeChatId(input);
  if (norm === null) return null;
  if (norm.startsWith('system:')) return null;
  const firstColon = norm.indexOf(':');
  const instance = norm.slice(0, firstColon);
  const inst = parseInstance(instance);
  const rest = norm.slice(firstColon + 1);
  const secondColon = rest.indexOf(':');
  const kind = rest.slice(0, secondColon);
  const id = rest.slice(secondColon + 1);
  return { instance, platform: inst.platform, kind, id };
}

/** 两个地址是不是同一个聊天：先各自规范化再比；认不出的一律不相等。禁止用 === 直接比地址。 */
export function sameChat(a, b) {
  const na = normalizeChatId(a);
  const nb = normalizeChatId(b);
  return na !== null && nb !== null && na === nb;
}

/**
 * 拼地址。只有网关和平台端可以调用（见 CONTRACTS.md §三.4）。
 * system: 类内部会话用 formatChatId({ instance:'system', platform:'system', kind:'system', id:名字 }) 之外
 * 的场景不存在——内部会话不拼，直接写字面量；这里只处理 private/group。
 */
export function formatChatId(address) {
  if (!address || typeof address !== 'object') return null;
  const { instance, kind, id } = address;
  if (!INSTANCE_RE.test(String(instance || ''))) return null;
  if (!KINDS.has(kind)) return null;
  if (id === undefined || id === null || String(id) === '') return null;
  return `${instance}:${kind}:${id}`;
}
