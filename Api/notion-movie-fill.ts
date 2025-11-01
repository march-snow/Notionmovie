// /api/notion-movie-fill.ts (Vercel Edge/Node compatible)
// 최소 구성: 노션 버튼(웹훅) → 이 엔드포인트 → OMDb 조회 → 노션 페이지 업데이트
// 준비물: NOTION_TOKEN, OMDB_API_KEY (환경변수)

import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const OMDB = process.env.OMDB_API_KEY as string;

// === 유틸: 한글 '~하다'체 간단 요약 ===
function summarizeKorean(plot: string) {
  if (!plot) return "작품 정보가 부족하여 간단 요약을 제공하지 못하다.";
  const cleaned = plot
    .replace(/\s+/g, " ")
    .replace(/[.!?]\s+/g, "하다. ")
    .replace(/입니다/g, "하다");
  const out = cleaned.length > 360 ? cleaned.slice(0, 356) + "…" : cleaned;
  // 종결 보정
  return /하다[.?!…]?$/.test(out) ? out : out + "하다.";
}

// === 유틸: 특징 자동 생성(간단 규칙) ===
function featuresFromData(director: string, genres: string[]) {
  const base: string[] = [];
  if (director) base.push(`연출: ${director}`);
  if (genres?.length) base.push(`장르 결합: ${genres.slice(0, 3).join(", ")}`);
  base.push("리듬감 있는 전개");
  return base.join(" / ");
}

async function fetchFromOMDb(title: string) {
  if (!OMDB) throw new Error("OMDB_API_KEY 누락");
  const url = `https://www.omdbapi.com/?apikey=${OMDB}&t=${encodeURIComponent(title)}&plot=full`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.Response === "False") throw new Error(json.Error || "OMDb not found");
  return {
    director: json.Director || "",
    plot: json.Plot || "",
    genres: (json.Genre || "").split(",").map((g: string) => g.trim()).filter(Boolean),
    released: json.Released || "",
    writers: json.Writer || "",
    actors: json.Actors || "",
  };
}

// === 노션 도우미 ===
async function getTitle(notionPage: any, titlePropName = "제목"): Promise<string> {
  const prop = notionPage.properties?.[titlePropName];
  const text = prop?.title?.[0]?.plain_text || prop?.title?.map((t: any) => t?.plain_text).join("") || "";
  return text.trim();
}

function asRichText(content: string) {
  return { rich_text: [{ type: "text", text: { content } }] } as const;
}

function asMultiSelect(names: string[]) {
  return { multi_select: names.map((name) => ({ name })) } as const;
}

function asDate(iso: string | null) {
  return iso ? { date: { start: iso } } : undefined;
}

function parseReleasedToISO(released: string): string | null {
  // OMDb 예시: "20 Jun 1988" → ISO
  const d = released ? new Date(released) : null;
  return d && !isNaN(+d) ? d.toISOString().slice(0, 10) : null;
}

export default async function handler(req: Request): Promise<Response> {
  try {
    // 1) 페이로드에서 page_id 추출 (본문 또는 헤더 폴백)
    let body: any = {};
    try { body = await req.json(); } catch {}
    const pageId = body.page_id || (req.headers.get("x-notion-page-id") ?? "").trim();
    if (!pageId) throw new Error("page_id 누락 (JSON body.page_id 또는 X-Notion-Page-Id 헤더 사용)");

    // 2) 노션 페이지 가져오기 및 제목 읽기
    const page = await notion.pages.retrieve({ page_id: pageId });
    const title = await getTitle(page);
    if (!title) throw new Error("노션 페이지의 '제목' 속성이 비어 있음");

    // 3) OMDb 조회
    const data = await fetchFromOMDb(title);

    // 4) 데이터 가공
    const 줄거리 = summarizeKorean(data.plot);
    const 특징 = featuresFromData(data.director, data.genres);
    const 개봉ISO = parseReleasedToISO(data.released);

    // 5) 노션 업데이트(속성명이 다르면 아래 키를 바꾸세요)
    const props: Record<string, any> = {
      "감독": asRichText(data.director),
      "줄거리": asRichText(줄거리),
      "특징": asRichText(특징),
      "장르": asMultiSelect(data.genres),
      "개봉일": asDate(개봉ISO),
      "제작/스태프": asRichText(`각본: ${data.writers} / 출연: ${data.actors}`),
    };

    // 선택: 상태 컬럼이 존재한다면 '완료'로 설정 시도
    try { (props as any)["상태"] = { status: { name: "완료" } }; } catch {}

    await notion.pages.update({ page_id: pageId, properties: props });

    return new Response(JSON.stringify({ ok: true, title, updated: Object.keys(props) }), { status: 200 });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500 });
  }
}

// === .env 예시 ===
// NOTION_TOKEN=secret_xxx
// OMDB_API_KEY=your_omdb_key

// === 노션 버튼 웹훅 설정 팁 ===
// - URL: https://your-vercel-app.vercel.app/api/notion-movie-fill
// - Method: POST
// - Headers: X-Notion-Page-Id: {{Page ID}}
//   (또는 Body raw JSON: {"page_id": "{{Page ID}}"})
// - 권한: 이 통합(NOTION_TOKEN)을 해당 DB에 초대(Share)해야 업데이트 가능

