import { createClient } from "npm:@supabase/supabase-js@2.76.1";

const headers = {"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info","Access-Control-Allow-Methods":"GET,POST,PATCH,OPTIONS","Cache-Control":"no-store"};
const json = (body: unknown, status=200) => new Response(JSON.stringify(body),{status,headers});
const failResponse = (message: string,status=400) => json({error:message},status);
const uuid = (s:string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
const allowedPriorities = new Set(["low","medium","high","urgent"]);
const allowedChanges = new Set(["title","description","priority","completed","due_at","is_archived"]);
const url = Deno.env.get("SUPABASE_URL") || "";
const publishable = (() => {try {const keys=JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")||"{}");return keys.default||Object.values(keys)[0] as string} catch{return ""}})() || Deno.env.get("SUPABASE_ANON_KEY") || "";
function validPatch(body:Record<string,unknown>){
 const entries=Object.entries(body);
 if(!entries.length || entries.some(([key])=>!allowedChanges.has(key)))throw new Error("Unsupported or empty card update");
 const patch:Record<string,unknown>={};
 for(const [k,v] of entries){
  if(k==="title" && (typeof v!=="string" || !v.trim() || v.length>500))throw new Error("Invalid title");
  if(k==="description" && (typeof v!=="string" || v.length>10000))throw new Error("Invalid description");
  if(k==="priority" && !allowedPriorities.has(String(v)))throw new Error("Invalid priority");
  if((k==="completed"||k==="is_archived") && typeof v!=="boolean")throw new Error("Invalid boolean");
  if(k==="due_at" && v!==null && (typeof v!=="string" || !/^\\d{4}-\\d{2}-\\d{2}(?:T.*)?$/.test(v) || Number.isNaN(Date.parse(v))))throw new Error("Invalid due_at");
  patch[k]=k==="title"?(v as string).trim():v;
 }
 return patch;
}
async function bodyObject(req:Request){
 const raw=await req.text();
 if(raw.length>65536)throw new Error("Request exceeds 64 KiB");
 const obj=JSON.parse(raw);
 if(!obj || typeof obj!=="object" || Array.isArray(obj))throw new Error("JSON object required");
 return obj as Record<string,unknown>;
}
Deno.serve(async req=>{
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
 if(!url||!publishable)return failResponse("Server API configuration missing",503);
 const bearer=req.headers.get("Authorization")||"";
 if(!/^Bearer\\s+\\S+$/.test(bearer))return failResponse("User access token required",401);
 const token=bearer.replace(/^Bearer\\s+/,"");
 const client=createClient(url,publishable,{auth:{persistSession:false,autoRefreshToken:false},global:{headers:{Authorization:bearer}}});
 const {data:{user},error:authError}=await client.auth.getUser(token);
 if(authError || !user)return failResponse("Invalid or expired session",401);
 const path=new URL(req.url).pathname.replace(/^.*?\/agent-api\/?/,"").split("/").filter(Boolean);
 const method=req.method;
 try{
  if(method==="GET" && path.length===1 && path[0]==="health"){
   const {data,error}=await client.rpc("agent_runtime_health");
   if(error)throw error;
   return json({ok:true,userId:user.id,...(data||{})});
  }
  if(method==="GET" && path.length===1 && path[0]==="boards"){
   const {data,error}=await client.from("boards").select("id,title,description,workspace_id,updated_at").order("updated_at",{ascending:false}).limit(100);
   if(error)throw error;
   return json({boards:data||[]});
  }
  if(path[0]==="boards" && uuid(path[1]||"")){
   const boardId=path[1];
   const {data:board,error:boardErr}=await client.from("boards").select("id").eq("id",boardId).maybeSingle();
   if(boardErr)throw boardErr;
   if(!board)return failResponse("Board not found or access denied",404);
   if(method==="GET" && path[2]==="lists" && path.length===3){
    const {data,error}=await client.from("lists").select("id,board_id,title,position,is_collapsed,kind,is_archived,color").eq("board_id",boardId).order("position").limit(100);
    if(error)throw error;
    return json({lists:data||[]});
   }
   if(method==="GET" && path[2]==="cards" && path.length===3){
    const params=new URL(req.url).searchParams;
    const requested=Number(params.get("limit")||"100");
    if(!Number.isInteger(requested)||requested<1||requested>200)return failResponse("limit must be 1..200");
    const since=params.get("since");const offset=Number(params.get("offset")||"0");if(!Number.isInteger(offset)||offset<0||offset>100000)return failResponse("Invalid offset");
    let query=client.from("cards").select("id,board_id,list_id,title,description,priority,position,completed,due_at,updated_at,is_archived").eq("board_id",boardId).order("updated_at",{ascending:true}).order("id",{ascending:true}).range(offset,offset+requested);
    if(since){if(Number.isNaN(Date.parse(since)))return failResponse("Invalid since timestamp");query=query.gte("updated_at",since)}
    const {data,error}=await query;
    if(error)throw error;
    const rows=data||[];return json({cards:rows.slice(0,requested),hasMore:rows.length>requested,nextOffset:rows.length>requested?offset+requested:null,deletedCardsNotIncluded:true});
   }
   if(method==="GET" && path[2]==="runs" && path.length===3){
    const {data,error}=await client.from("agent_runs").select("id,card_id,status,attempts,created_at,updated_at,error").eq("board_id",boardId).order("created_at",{ascending:false}).limit(50);
    if(error)throw error;return json({runs:data||[]});
   }
   if(method==="POST" && path[2]==="cards" && path.length===3){
    const input=await bodyObject(req);
    if(!uuid(String(input.list_id||"")) || typeof input.title!=="string" || !input.title.trim() || input.title.length>500)return failResponse("Valid list_id and title required");
    const {data:list,error:listErr}=await client.from("lists").select("id,kind,is_archived").eq("id",input.list_id).eq("board_id",boardId).maybeSingle();
    if(listErr)throw listErr;if(!list||list.kind!=="normal"||list.is_archived)return failResponse("Destination list unavailable",422);
    const {data,error}=await client.from("cards").insert({board_id:boardId,list_id:list.id,title:input.title.trim(),description:typeof input.description==="string"?input.description.slice(0,10000):"",priority:allowedPriorities.has(String(input.priority))?input.priority:"medium",position:Number.isFinite(Number(input.position))?Number(input.position):100000}).select("id,board_id,list_id,title,position").single();
    if(error)throw error;return json({card:data},201);
   }
  }
  if(path[0]==="cards" && uuid(path[1]||"")){
   const id=path[1];
   const {data:card,error:cardErr}=await client.from("cards").select("id,board_id,list_id").eq("id",id).maybeSingle();
   if(cardErr)throw cardErr;if(!card)return failResponse("Card not found or access denied",404);
   if(method==="PATCH" && path.length===2){
    const patch=validPatch(await bodyObject(req));
    const {data,error}=await client.from("cards").update(patch).eq("id",id).select("id,title,updated_at,completed,is_archived").single();
    if(error)throw error;return json({card:data});
   }
   if(method==="POST" && path[2]==="move" && path.length===3){
    const input=await bodyObject(req); const listId=String(input.list_id||"");
    if(!uuid(listId)||!Number.isFinite(Number(input.position))||Number(input.position)<0)return failResponse("Valid list_id and nonnegative position required");
    const {data:list,error:listErr}=await client.from("lists").select("id,kind,is_archived").eq("board_id",card.board_id).eq("id",listId).maybeSingle();
    if(listErr)throw listErr;if(!list || list.kind!=="normal" || list.is_archived)return failResponse("Destination list unavailable",422);
    const {data,error}=await client.from("cards").update({list_id:listId,position:input.position}).eq("id",id).select("id,list_id,position").single();
    if(error)throw error;return json({card:data});
   }
   if(method==="POST" && path[2]==="queue" && path.length===3){
    const input=await bodyObject(req);const key=String(input.idempotency_key||"");
    if(!key||key.length>120)return failResponse("idempotency_key required (up to 120 characters)");
    const {data,error}=await client.rpc("queue_card_for_ai",{p_card_id:id,p_idempotency_key:key});
    if(error)throw error;return json({run:data});
   }
  }
  return failResponse("Unknown API route",404);
 }catch(e){
  const message=e instanceof Error?e.message:String((e as {message?:string}).message||"Request failed");
  const isClient=/Invalid|Unsupported|not found|denied|violates|duplicate|permission/i.test(message);
  console.error("agent-api",message);
  return failResponse(isClient?message:"Operation failed",isClient?422:500);
 }
});
