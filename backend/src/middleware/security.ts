import crypto from "node:crypto";import type{NextFunction,Request,Response}from"express";import{rateLimit}from"express-rate-limit";
export function requestContext(req:Request,res:Response,next:NextFunction){const id=String(req.headers["x-request-id"]||crypto.randomUUID()).slice(0,100);res.locals.requestId=id;res.setHeader("X-Request-Id",id);const started=Date.now();res.on("finish",()=>console.info(JSON.stringify({type:"request",requestId:id,method:req.method,path:req.path,status:res.statusCode,durationMs:Date.now()-started})));next()}
const common={standardHeaders:"draft-8" as const,legacyHeaders:false,handler:(_req:Request,res:Response)=>res.status(429).json({ok:false,code:"RATE_LIMITED",message:"Demasiadas solicitudes. Intenta nuevamente en unos minutos."})};
export const apiLimiter=rateLimit({windowMs:15*60*1000,limit:Number(process.env.API_RATE_LIMIT||600),...common});
export const translationLimiter=rateLimit({windowMs:60*1000,limit:Number(process.env.TRANSLATION_RATE_LIMIT||30),...common});
export const billingLimiter=rateLimit({windowMs:15*60*1000,limit:20,...common});
