#!/usr/bin/env node
// Glassboard agent CLI. Uses a signed-in user's JWT, never the service-role key.
const base=(process.env.SUPABASE_URL||process.env.VITE_SUPABASE_URL||"").replace(/\/$/,"");
const publicKey=process.env.SUPABASE_PUBLISHABLE_KEY||process.env.SUPABASE_ANON_KEY||process.env.VITE_SUPABASE_ANON_KEY||"";
const usage=`Glassboard agent CLI
Required: SUPABASE_URL, SUPABASE_ANON_KEY, and either GLASSBOARD_ACCESS_TOKEN
or GLASSBOARD_EMAIL + GLASSBOARD_PASSWORD.

Commands:
  health
  boards
  lists <boardId>
  cards <boardId> [since]
  runs <boardId>
  create <boardId> <listId> <title>
  update <cardId> '<JSON patch>'
  move <cardId> <listId> <position>
  queue <cardId> <idempotencyKey>`;
if(!base||!publicKey){console.error(usage);process.exit(2)}
const [command,...args]=process.argv.slice(2);
if(!command||['--help','help','-h'].includes(command)){console.log(usage);process.exit(0)}
async function request(url,options={}){
 const res=await fetch(url,options);
 const text=await res.text();
 let payload;try{payload=text?JSON.parse(text):null}catch{payload={error:text.slice(0,300)}}
 if(!res.ok)throw new Error(`${res.status}: ${payload?.error||payload?.msg||payload?.message||"Request failed"}`);
 return payload;
}
async function token(){
 if(process.env.GLASSBOARD_ACCESS_TOKEN)return process.env.GLASSBOARD_ACCESS_TOKEN;
 const email=process.env.GLASSBOARD_EMAIL,password=process.env.GLASSBOARD_PASSWORD;
 if(!email||!password)throw new Error("Provide GLASSBOARD_ACCESS_TOKEN or GLASSBOARD_EMAIL and GLASSBOARD_PASSWORD");
 const data=await request(`${base}/auth/v1/token?grant_type=password`,{method:"POST",headers:{"Content-Type":"application/json",apikey:publicKey},body:JSON.stringify({email,password})});
 if(!data?.access_token)throw new Error("Sign-in did not return a user access token");
 return data.access_token;
}
async function main(){
 const auth=await token();
 const h={Authorization:`Bearer ${auth}`,apikey:publicKey,"Content-Type":"application/json"};
 let path="",method="GET",body;
 const enc=encodeURIComponent;
 switch(command){
  case "health":path="health";break;
  case "boards":path="boards";break;
  case "lists":path=`boards/${enc(args[0]||"")}/lists`;break;
  case "cards":path=`boards/${enc(args[0]||"")}/cards${args[1]?`?since=${enc(args[1])}`:""}`;break;
  case "runs":path=`boards/${enc(args[0]||"")}/runs`;break;
  case "create":
   if(args.length<3)throw new Error("create requires boardId, listId, title");
   method="POST";path=`boards/${enc(args[0])}/cards`;body={list_id:args[1],title:args.slice(2).join(" ")};break;
  case "update":
   if(args.length!==2)throw new Error("update requires cardId and JSON patch");
   method="PATCH";path=`cards/${enc(args[0])}`;body=JSON.parse(args[1]);break;
  case "move":
   if(args.length!==3)throw new Error("move requires cardId, listId, position");
   method="POST";path=`cards/${enc(args[0])}/move`;body={list_id:args[1],position:Number(args[2])};break;
  case "queue":
   if(args.length!==2)throw new Error("queue requires cardId, idempotencyKey");
   method="POST";path=`cards/${enc(args[0])}/queue`;body={idempotency_key:args[1]};break;
  default:throw new Error(`Unknown command ${command}`);
 }
 const result=await request(`${base}/functions/v1/agent-api/${path}`,{method,headers:h,...(body?{body:JSON.stringify(body)}:{})});
 console.log(JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
