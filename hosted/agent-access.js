/* Opt-in agent connection.
   The browser uses the signed-in Firebase token only to create, list, and
   revoke personal access tokens. Hermes and other MCP clients then call the
   same Cloud Function with the sb_ token, which never returns to this page
   after the moment it is created. */
(function(root){
  "use strict";

  function cfg(){
    var rootCfg=root.ASTRAL_CONFIG||{};
    return rootCfg.agentAccess&&typeof rootCfg.agentAccess==="object"?rootCfg.agentAccess:{};
  }
  function baseUrl(){ return String(cfg().baseUrl||"").replace(/\/+$/,""); }
  function join(path){ return baseUrl()+"/"+String(path||"").replace(/^\/+/,""); }

  function request(path, opts){
    opts=opts||{};
    if(!baseUrl()) return Promise.reject(new Error("Agent access is not configured in this build."));
    var getToken=opts.getIdToken;
    if(typeof getToken!=="function") return Promise.reject(new Error("Sign in to connect an agent."));
    return getToken().then(function(token){
      if(!token) throw new Error("Sign in to connect an agent.");
      var headers={Authorization:"Bearer "+token};
      if(opts.body) headers["Content-Type"]="application/json";
      return fetch(join(path),{method:opts.method||"GET",headers:headers,body:opts.body||undefined});
    }).then(function(response){
      return response.text().then(function(raw){
        var data=null;
        try{ data=JSON.parse(raw); }catch(e){}
        if(!response.ok){
          var err=new Error((data&&data.error)||("Agent access failed ("+response.status+")."));
          err.status=response.status;
          err.code=data&&data.code;
          throw err;
        }
        return data||{};
      });
    });
  }

  root.SecondBrainAgent={
    configured:function(){ return !!baseUrl(); },
    baseUrl:baseUrl,
    mcpUrl:function(){ return baseUrl()+"/mcp"; },
    listTokens:function(getIdToken){ return request("/tokens",{method:"GET",getIdToken:getIdToken}); },
    createToken:function(getIdToken,name){ return request("/tokens",{method:"POST",getIdToken:getIdToken,body:JSON.stringify({name:name||""})}); },
    revokeToken:function(getIdToken,id){ return request("/tokens/revoke",{method:"POST",getIdToken:getIdToken,body:JSON.stringify({id:id})}); }
  };
})(typeof window!=="undefined"?window:globalThis);
