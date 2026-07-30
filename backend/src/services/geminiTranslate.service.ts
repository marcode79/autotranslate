import { GoogleGenerativeAI } from "@google/generative-ai";
import type { UsageMetadata } from "./usage.service.js";
export type TranslateAudioParams={audioBase64:string;mimeType:string;sourceLanguage:string;targetLanguage:string;previousContext:string};
export type TranslateAudioResult={transcript:string;translation:string;detectedLanguage:string;isFinal:boolean;model:string;usageMetadata:UsageMetadata};
const FALLBACKS=["gemini-2.5-flash-lite","gemini-2.5-flash","gemini-1.5-flash"];
const LANG:Record<string,string>={auto:"auto-detect",en:"English",es:"Spanish",pt:"Portuguese",fr:"French"};
function candidates(){const preferred=(process.env.GEMINI_MODEL||"").split("#")[0].trim();return preferred?[preferred,...FALLBACKS.filter(x=>x!==preferred)]:FALLBACKS}
function payload(text:string){const parsed=JSON.parse(text.trim().replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/```$/i,"").trim());return{transcript:String(parsed.transcript||"").trim(),translation:String(parsed.translation||"").trim(),detectedLanguage:String(parsed.detectedLanguage||"unknown").trim(),isFinal:Boolean(parsed.isFinal??true)}}
function fallbackError(e:unknown){const m=String((e as {message?:string})?.message??e).toLowerCase();return m.includes("model")&&(m.includes("not found")||m.includes("unexpected model name format"))}
export async function translateAudioChunk(p:TranslateAudioParams):Promise<TranslateAudioResult>{
 const key=process.env.GEMINI_API_KEY?.trim();if(!key)throw new Error("Missing GEMINI_API_KEY in backend/.env.");const ai=new GoogleGenerativeAI(key);
 const source=LANG[p.sourceLanguage]??p.sourceLanguage,target=LANG[p.targetLanguage]??p.targetLanguage;
 const prompt=["You are a low-latency meeting interpreter.","Transcribe only the speech in this audio chunk and translate it.","Return strict JSON only with these fields: transcript, translation, detectedLanguage, isFinal.",`The translation must always be written in ${target}.`,source==="auto-detect"?"Detect the spoken source language from the audio.":`Expected source language is ${source}.`,`Source language hint: ${source}. Target language: ${target}.`,p.previousContext?`Recent context for wording only: ${p.previousContext.slice(-600)}`:""].filter(Boolean).join("\n");
 let last:unknown;for(const modelName of candidates()){try{const model=ai.getGenerativeModel({model:modelName,generationConfig:{temperature:0,topP:1,candidateCount:1,responseMimeType:"application/json"} as any});const response=await model.generateContent([{text:prompt},{inlineData:{mimeType:p.mimeType,data:p.audioBase64}}]);return{...payload(response.response.text()),model:modelName,usageMetadata:(response.response.usageMetadata??{}) as UsageMetadata};}catch(e){last=e;if(fallbackError(e))continue;throw e}}
 throw last??new Error("Gemini model unavailable.");
}
