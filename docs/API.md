# API-kontrakt

Backend uppfyller det API som LAWLA_NEW:s Worker proxar (`/api/*`) och tar över det Workern i dag
lagrar själv. DTO:er enligt `src/api/types.ts` i LAWLA_NEW (avstämt 2026-10-20). Alla endpoints
utom de markerade *(öppen)* kräver `Authorization: Bearer <JWT>`.

## Auth
| Metod | Path | Kommentar |
|---|---|---|
| POST | `/api/Auth/login` | `{email,password}` → `{token,user}` |
| POST | `/api/Auth/register` | `{email,password,name}` → `{token?,user?,message?}` (enligt feature flags) |
| POST | `/api/Auth/validate` | `{token}` → `UserDto` |
| GET | `/api/Auth/google?returnUrl=` *(öppen)* | redirect till Google; tillbaka till `returnUrl?token=` (vitlista) |
| GET | `/api/System/features` *(öppen)* | `FeatureStatusDto` |

## Ärenden (`/api/Projects`)
| Metod | Path |
|---|---|
| GET/POST | `/api/Projects` |
| GET/PUT/DELETE | `/api/Projects/:id` (`UpdateProjectRequest` + nytt fält `mainPrompt`) |
| POST | `/api/Projects/:id/questions` · `/circumstances` · `/legal-issues` `{text}` |
| PUT/DELETE | `/api/Projects/:id/{questions|circumstances|legal-issues}/:itemId` |
| GET | `/api/Projects/:id/evidence/expanded` (`ExpandedEvidenceDto[]` + `documentType`, `updatedAt`) |
| POST | `/api/Projects/:id/evidence` (`AddEvidenceRequest`; accepterar bara `documentId`, eller bara `content` + `externalUrl`) |
| PUT/DELETE | `/api/Projects/:id/evidence/:eid` (**ny PUT**: `displayLabel`, `annotation`) |
| GET | `/api/Projects/:id/legal-issues/:iid/analyses` |
| POST | `/api/Projects/:id/legal-issues/:iid/analyze` `{instructions?}` → SSE eller `LegalIssueAnalysisDto` |
| GET/POST | `/api/Projects/:id/analyses` (POST strömmar SSE vid `Accept: text/event-stream`) |

Analys-DTO:er får fältet `citations: [{ text, chunkId, evidenceId, start, end, status }]`.

### Nytt – tas över från Workern
| Metod | Path | Ersätter |
|---|---|---|
| GET/POST | `/api/Projects/:id/versions`, GET `/versions/:vid` | `worker/history.ts` |
| GET/POST | `/api/Projects/:id/shares`, DELETE `/shares/:token` | `worker/share.ts` |
| GET | `/api/shares/:token` *(öppen, noindex)* | `/share/view/:token` |
| GET/PUT | `/api/Projects/:id/notes/:sourceKey` | `worker/notes.ts` |
| POST | `/api/feedback`; GET/PATCH/DELETE admin | Supabase-tabellerna |

## Korpus
| Metod | Path |
|---|---|
| GET | `/api/Documents/stats` · `/api/Documents?page&pageSize&search&tag&documentType&searchContent` |
| GET | `/api/Documents/:id` · `/:id/chunks` · `/:id/toc` · `/api/Documents/chunks/:chunkId` |
| GET | `/api/References/document/:id/outgoing` · `/incoming` · **ny** `/api/References/outgoing?documentIds=1,2,3` |
| POST | `/api/Search` **ny** `{query, topK?, documentTypes?, onlyCurrent?}` → träffar med poäng per väg |
| GET | `/api/Lagrum/resolve?q=` **ny** – exakt uppslag av hänvisning i korpusen (ersätter lagen.nu-kontrollen när källan finns lokalt) |
| POST | `/api/Ingest` **ny, admin** `{source:"lagen.nu", uri}` → jobb |

## RAG
| Metod | Path |
|---|---|
| POST | `/api/Rag/query-stream` (`RagQueryRequest` + **ny** `projectId`) → SSE `StreamEvent` |

## SSE-format
```
data: {"type":"status","content":"Söker…"}
data: {"type":"sources","sources":[…]}
data: {"type":"content","content":"…"}
data: {"type":"done","analysisContent":"…","processingTimeMs":1234}
```
