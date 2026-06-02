type ApprovalParameter = {
  name?: string;
  value?: unknown;
};

type ApprovalTransaction = {
  id: string;
  hash: string;
  blockNumber: bigint;
  timestamp: Date;
  fromAddress: string;
  toAddress?: string | null;
  raw?: unknown;
};

export type ApprovalBadge = {
  hash: string;
  token: string | null;
  spender: string;
  amount: string | null;
};

function rawBlockscout(transaction: { raw?: unknown }) {
  if (!transaction.raw || typeof transaction.raw !== "object") return undefined;
  const raw = transaction.raw as { blockscout?: unknown };
  return raw.blockscout && typeof raw.blockscout === "object" ? (raw.blockscout as { decoded_input?: unknown; method?: unknown }) : undefined;
}

function decodedInput(transaction: { raw?: unknown }) {
  const blockscout = rawBlockscout(transaction);
  if (!blockscout?.decoded_input || typeof blockscout.decoded_input !== "object") return undefined;
  return blockscout.decoded_input as { method_call?: string; parameters?: ApprovalParameter[] };
}

function blockscoutMethod(transaction: { raw?: unknown }) {
  const method = rawBlockscout(transaction)?.method;
  return typeof method === "string" ? method.toLowerCase() : null;
}

function parameterValue(parameters: ApprovalParameter[] | undefined, names: string[]) {
  const lowered = new Set(names.map((name) => name.toLowerCase()));
  return parameters?.find((parameter) => parameter.name && lowered.has(parameter.name.toLowerCase()))?.value;
}

export function getApprovalBadge(transaction: ApprovalTransaction): ApprovalBadge | null {
  const decoded = decodedInput(transaction);
  if (!decoded?.method_call) return null;
  const method = decoded.method_call.toLowerCase();

  if (method.startsWith("setapprovalforall(")) {
    const operator = parameterValue(decoded.parameters, ["operator"]);
    const approved = parameterValue(decoded.parameters, ["approved"]);
    if (typeof operator !== "string" || approved !== true) return null;

    return {
      hash: transaction.hash,
      token: transaction.toAddress ?? null,
      spender: operator,
      amount: "all"
    };
  }

  if (!method.startsWith("approve(")) return null;

  const spender = parameterValue(decoded.parameters, ["spender", "guy", "to"]);
  const amount = parameterValue(decoded.parameters, ["amount", "value", "wad", "tokenId"]);
  if (typeof spender !== "string" || spender === "0x0000000000000000000000000000000000000000") return null;

  return {
    hash: transaction.hash,
    token: transaction.toAddress ?? null,
    spender,
    amount: typeof amount === "string" ? amount : null
  };
}

export function isApprovalTransaction(transaction: ApprovalTransaction) {
  if (getApprovalBadge(transaction) !== null) return true;

  const method = blockscoutMethod(transaction);
  return method === "approve" || method === "setapprovalforall";
}

export function mapApprovalsToTransactions<T extends ApprovalTransaction>(transactions: T[]) {
  const approvalsByTargetId = new Map<string, ApprovalBadge[]>();
  const pendingApprovals = new Map<string, ApprovalBadge>();
  const chronological = [...transactions].sort((a, b) => {
    const blockDelta = a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0;
    if (blockDelta !== 0) return blockDelta;
    return a.timestamp.getTime() - b.timestamp.getTime();
  });

  for (const transaction of chronological) {
    const approval = getApprovalBadge(transaction);
    const source = transaction.fromAddress.toLowerCase();

    if (approval) {
      const key = [source, approval.spender.toLowerCase(), approval.token?.toLowerCase() ?? ""].join(":");
      pendingApprovals.set(key, approval);
      continue;
    }

    const targetSpender = transaction.toAddress?.toLowerCase();
    if (!targetSpender) continue;

    const matchedApprovals = [...pendingApprovals.entries()].filter(([key]) => key.startsWith(`${source}:${targetSpender}:`));
    if (matchedApprovals.length === 0) continue;

    approvalsByTargetId.set(
      transaction.id,
      matchedApprovals.map(([, matchedApproval]) => matchedApproval)
    );
    for (const [key] of matchedApprovals) pendingApprovals.delete(key);
  }

  return approvalsByTargetId;
}
