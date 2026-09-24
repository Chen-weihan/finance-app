// Supabase Edge Function: scan-invoice
// 收到發票照片(base64) → 呼叫 Claude 讀出品名/規格/單價/總價 → 回傳 JSON
// 需要的 Secret：ANTHROPIC_API_KEY（在 Supabase 後台設定，程式裡不寫死）

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    // 只允許登入的使用者呼叫（避免被別人亂用花錢）
    const authHeader = req.headers.get("Authorization") || "";
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return json({ error: "請先登入" }, 401);

    const { image, media_type } = await req.json();
    if (!image) return json({ error: "沒有收到影像" }, 400);

    const prompt =
      "你是記帳助手。這是一張台灣進貨單／發票的照片。請讀出：發票日期、供應商／店家名稱，以及每一列品項。" +
      "只回傳純 JSON、不要任何多餘文字，格式：" +
      '{"date":"YYYY-MM-DD","supplier":"店家名稱","items":[{"name":"品名","spec":"規格","price":單價數字,"total":總價數字}]}。' +
      "規則：日期轉成西元 YYYY-MM-DD（若是民國年請把年份加 1911，例如 115 年→2026 年）；" +
      "讀不到日期或供應商就給空字串；金額只保留數字（去掉逗號、貨幣符號）；" +
      "單價看不清楚給 0；只回 JSON。";

    const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: media_type || "image/jpeg", data: image } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });

    const aiData = await aiResp.json();
    if (!aiResp.ok) return json({ error: "AI 讀取失敗", detail: aiData }, 502);

    const text = aiData?.content?.[0]?.text ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    let out = { date: "", supplier: "", items: [] as unknown[] };
    if (match) {
      try {
        const p = JSON.parse(match[0]);
        out = { date: p.date || "", supplier: p.supplier || "", items: p.items || [] };
      } catch (_) { /* keep default */ }
    }
    return json(out);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
