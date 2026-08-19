/* Hosted AI credits client.
   Talks only to the Second Brain Cloud Function. Provider keys never enter
   this browser. The function authenticates the Firebase user, holds credits,
   calls the provider, then settles the 5× billed amount from the prepaid
   balance. */
(function(root){
  "use strict";

  var MARKUP=5, MICROS=1000000;
  var DEFAULT_PACKS=[
    {id:"credits_5",dollars:5,label:"$5"},
    {id:"credits_10",dollars:10,label:"$10"},
    {id:"credits_25",dollars:25,label:"$25"},
    {id:"credits_50",dollars:50,label:"$50"}
  ];
  var api={markup:MARKUP,packs:DEFAULT_PACKS};

  function cfg(){
    var rootCfg=root.ASTRAL_CONFIG||{};
    return rootCfg.hostedAi&&typeof rootCfg.hostedAi==="object"?rootCfg.hostedAi:{};
  }
  function baseUrl(){ return String(cfg().baseUrl||"").replace(/\/+$/,""); }
  api.configured=function(){ return !!baseUrl(); };
  api.formatUsd=function(micros){
    var value=Math.max(0,Number(micros)||0)/MICROS;
    return "$"+value.toFixed(2);
  };
  api.providerBudget=function(billedMicros){ return Math.floor(Math.max(0,Number(billedMicros)||0)/MARKUP); };

  function join(path){ return baseUrl()+"/"+(String(path||"").replace(/^\/+/,"")); }

  function request(path,opts){
    opts=opts||{};
    if(!baseUrl()) return Promise.reject(new Error("Hosted AI credits are not configured yet."));
    var getToken=opts.getIdToken;
    if(typeof getToken!=="function") return Promise.reject(new Error("Sign in to use hosted AI credits."));
    return getToken().then(function(token){
      if(!token) throw new Error("Sign in to use hosted AI credits.");
      var headers=opts.headers?Object.assign({},opts.headers):{};
      headers.Authorization="Bearer "+token;
      if(opts.body&&!headers["Content-Type"]&&!(opts.body instanceof FormData)&&!(opts.body instanceof Blob)){
        headers["Content-Type"]="application/json";
      }
      return fetch(join(path),{
        method:opts.method||"GET",
        headers:headers,
        body:opts.body,
        signal:opts.signal
      });
    }).then(function(response){
      var type=(response.headers.get("Content-Type")||"").toLowerCase();
      if(type.indexOf("audio/")===0||opts.binary){
        if(!response.ok){
          return response.text().then(function(raw){
            var data=null; try{ data=JSON.parse(raw); }catch(e){}
            throw new Error((data&&data.error)||("Hosted voice failed ("+response.status+")."));
          });
        }
        return response.blob().then(function(blob){
          blob._hosted={
            billedMicros:Number(response.headers.get("X-Hosted-Billed-Micros"))||0,
            providerMicros:Number(response.headers.get("X-Hosted-Provider-Micros"))||0,
            balanceMicros:Number(response.headers.get("X-Hosted-Balance-Micros"))||0
          };
          var encoded=response.headers.get("X-Hosted-Usage");
          if(encoded){
            try{ blob._hosted.usage=JSON.parse(decodeURIComponent(encoded)); }catch(e){}
          }
          return blob;
        });
      }
      return response.text().then(function(raw){
        var data=null; try{ data=JSON.parse(raw); }catch(e){}
        if(!response.ok){
          var err=new Error((data&&data.error)||("Hosted AI failed ("+response.status+")."));
          err.code=data&&data.code; err.status=response.status; err.body=data;
          throw err;
        }
        return data;
      });
    });
  }

  api.catalog=function(getIdToken){ return request("catalog",{getIdToken:getIdToken}); };
  api.billing=function(getIdToken){ return request("billing",{getIdToken:getIdToken}); };
  api.checkout=function(getIdToken,packId){
    return request("checkout",{method:"POST",getIdToken:getIdToken,body:JSON.stringify({packId:packId||"credits_10"})});
  };
  api.chat=function(getIdToken,body,signal){
    return request("chat",{method:"POST",getIdToken:getIdToken,body:JSON.stringify(body||{}),signal:signal});
  };
  api.tts=function(getIdToken,text,voiceId,meta,signal){
    return request("tts",{method:"POST",getIdToken:getIdToken,binary:true,signal:signal,body:JSON.stringify({
      text:text,voiceId:voiceId||"",agentId:meta&&meta.agentId||"",agentName:meta&&meta.agentName||""
    })});
  };
  api.stt=function(getIdToken,blob,meta,signal){
    return blob.arrayBuffer().then(function(buffer){
      var bytes=new Uint8Array(buffer), binary="", i;
      for(i=0;i<bytes.length;i++) binary+=String.fromCharCode(bytes[i]);
      var audio=btoa(binary);
      return request("stt",{method:"POST",getIdToken:getIdToken,signal:signal,body:JSON.stringify({
        audio:audio,
        mimeType:blob.type||"audio/webm",
        filename:meta&&meta.filename||"speech.webm",
        agentId:meta&&meta.agentId||"",
        agentName:meta&&meta.agentName||""
      })});
    });
  };
  api.voices=function(getIdToken,voiceId){
    return request("voices"+(voiceId?("?voiceId="+encodeURIComponent(voiceId)):""),{getIdToken:getIdToken});
  };
  api.roleBucket=function(role,kind){
    if(kind==="purchase") return "credits";
    if(kind==="voice"||role==="voice") return "voice";
    if(role==="subconscious"||role==="listen") return "subconscious";
    if(role==="utility") return "utility";
    return "conscious";
  };
  api.summarizeEvents=function(events){
    var out={calls:0,tokens:0,inputTokens:0,outputTokens:0,billedMicros:0,providerMicros:0,byRole:{},byModel:{},recent:[]};
    (events||[]).forEach(function(entry){
      if(!entry||entry.kind==="purchase") return;
      var role=api.roleBucket(entry.role,entry.kind);
      var tokens=(Number(entry.inputTokens)||0)+(Number(entry.outputTokens)||0);
      out.calls+=1;
      out.tokens+=tokens;
      out.inputTokens+=Number(entry.inputTokens)||0;
      out.outputTokens+=Number(entry.outputTokens)||0;
      out.billedMicros+=Number(entry.billedMicros)||0;
      out.providerMicros+=Number(entry.providerMicros)||0;
      if(!out.byRole[role]) out.byRole[role]={calls:0,tokens:0,billedMicros:0,chars:0};
      out.byRole[role].calls+=1;
      out.byRole[role].tokens+=tokens;
      out.byRole[role].billedMicros+=Number(entry.billedMicros)||0;
      out.byRole[role].chars+=Number(entry.chars)||0;
      var model=entry.model||"unknown";
      if(!out.byModel[model]) out.byModel[model]={calls:0,tokens:0,billedMicros:0};
      out.byModel[model].calls+=1;
      out.byModel[model].tokens+=tokens;
      out.byModel[model].billedMicros+=Number(entry.billedMicros)||0;
      out.recent.push(entry);
    });
    return out;
  };

  root.SecondBrainHosted=api;
})(window);
