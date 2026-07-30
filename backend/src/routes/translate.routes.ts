import { Router } from "express";
import { requireUser, type AuthenticatedRequest } from "../auth/requireUser.js";
import { requireApprovedUser } from "../auth/requireApprovedUser.js";
import { adminClient } from "../lib/supabase.js";
import { translateAudioChunk } from "../services/geminiTranslate.service.js";
import { calculateCost } from "../services/usage.service.js";
import { finalizeUsage, releaseUsage, reserveUsage, type Reservation } from "../services/quota.service.js";
const router=Router();router.use(requireUser,requireApprovedUser);
router.post("/audio",async(req,res,next)=>{let reservation:Reservation|undefined;let userId="";try{
 userId=(req as AuthenticatedRequest).auth.userId;const{audioBase64,mimeType,sourceLanguage,targetLanguage,previousContext,conversationId,audioDurationMs}=req.body??{};
 if(typeof audioBase64!=="string"||audioBase64.length<64)return res.status(400).json({ok:false,message:"audioBase64 is required."});
 if(typeof mimeType!=="string"||!mimeType.startsWith("audio/"))return res.status(400).json({ok:false,message:"A valid audio mimeType is required."});
 if(typeof conversationId!=="string")return res.status(400).json({ok:false,message:"conversationId is required."});
 const duration=Math.max(1000,Math.min(Number(audioDurationMs)||0,60000)),db=adminClient();
 const{data:conversation}=await db.from("conversations").select("id,title").eq("id",conversationId).eq("user_id",userId).maybeSingle();if(!conversation)return res.status(404).json({ok:false,message:"Conversation not found."});
 reservation=await reserveUsage(userId,duration);
 const result=await translateAudioChunk({audioBase64,mimeType,sourceLanguage:typeof sourceLanguage==="string"?sourceLanguage:"auto",targetLanguage:typeof targetLanguage==="string"?targetLanguage:"es",previousContext:typeof previousContext==="string"?previousContext:""});
 const usage=calculateCost(result.usageMetadata);
 const{data:segment,error:segmentError}=await db.from("conversation_segments").insert({conversation_id:conversationId,user_id:userId,transcript:result.transcript,translation:result.translation,detected_language:result.detectedLanguage,audio_duration_ms:duration}).select().single();if(segmentError)throw segmentError;
 const{error:usageError}=await db.from("ai_usage_events").insert({user_id:userId,conversation_id:conversationId,model:result.model,prompt_tokens:result.usageMetadata.promptTokenCount??0,output_tokens:usage.outputTokens,thinking_tokens:usage.thinkingTokens,total_tokens:usage.totalTokens,audio_tokens:usage.audioTokens,text_input_tokens:usage.textInputTokens,audio_duration_ms:duration,estimated_cost_micros:usage.estimatedCostMicros,price_snapshot:usage.rates});if(usageError)throw usageError;
 await finalizeUsage(userId,reservation,duration,usage.totalTokens,usage.estimatedCostMicros);reservation=undefined;
 if(conversation.title==="Nueva conversación"&&result.transcript){await db.from("conversations").update({title:result.transcript.replace(/\s+/g," ").trim().slice(0,72)}).eq("id",conversationId).eq("user_id",userId)}
 res.json({ok:true,...result,usageMetadata:undefined,segmentId:segment.id,usage:{totalTokens:usage.totalTokens,estimatedCostMicros:usage.estimatedCostMicros}});
 }catch(e){if(reservation&&userId)await releaseUsage(userId,reservation);const code=(e as any)?.code;if(code==="QUOTA_EXCEEDED")return res.status(402).json({ok:false,code,message:(e as Error).message});next(e)}});
export default router;
