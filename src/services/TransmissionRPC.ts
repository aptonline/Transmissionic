/**
 * Transmission RPC Client for Ionic/Capacitor, inspired by kkito-transmission-rpc
*/

import { isPlatform  } from '@ionic/vue';
import { HTTP } from '@ionic-native/http';

declare const Buffer: any
declare global {
  interface Window {
    net: any;
  }
}

type Method = "get" | "post" | "put" | "patch" | "head" | "delete" | "options" | "upload" | "download";
type Serializer = "json" | "urlencoded" | "utf8" | "multipart" | "raw" | undefined;

class TRPC {
  sessionToken: any;
  sessionArguments: any;
  options: any;
  lastRequestId: number;
  useNativePlugin: boolean;
  persistentData: any;
  persistentDataValid=false;
  freeSpaceRefreshInterval: any;
  pathMapping: Record<string,string>;

  constructor() {
    this.useNativePlugin = (isPlatform("capacitor") && (isPlatform("android") || isPlatform("ios")))
    this.lastRequestId = 0;
    this.pathMapping = {};
  }

  async setServer(options: Record<string, any> = {}, timeout=5): Promise<Record<string, any>> {
    this.sessionToken=null;
    this.options = {
      host:'localhost',
      path:'/transmission/rpc',
      port:9091,
      https:false,
      timeout:timeout
    };
    
    for (const [key, value] of Object.entries(options)) {
      if(value!=""){
        this.options[key]=value;
      }
    }

    if(this.options.pathMapping){
      this.pathMapping = this.readPathMapping(this.options.pathMapping)
    }

    this.setAuthHeader();
    this.invalidatePersitentData();
    this.setFreeSpaceRefreshInterval();

    this.sessionArguments = await this.getSession();

    return this.sessionArguments;
  }

  readPathMapping(pathMapping: string): Record<string,string> {
    const result: Record<string,string> = {};
    pathMapping.split(/\r?\n/).forEach((pathMap: string) => {
      const paths = pathMap.match(/^(.+) ?= ?(.+)$/)||[];
      for(const key in paths){
        if(paths[key]){
          if(paths[key].startsWith(' ')){
            paths[key]=paths[key].substr(1);
          }
          if(paths[key].endsWith(' ')){
            paths[key]=paths[key].slice(0, -1);
          }
        }
      }
      if(paths.length>=3){
        result[paths[1]]=paths[2];
      }
    });
    return result;
  }

  setAuthHeader(): void {
    if(this.useNativePlugin){
      HTTP.setRequestTimeout(5);
      if(this.options.auth){
        HTTP.useBasicAuth(this.options.auth.username,this.options.auth.password);
      }
      else {
        // Reset auth header from previous connection
        HTTP.useBasicAuth("","");
      }
    }
  }

  setFreeSpaceRefreshInterval(): void {
    clearInterval(this.freeSpaceRefreshInterval);
    this.freeSpaceRefreshInterval = setInterval(async () => {
      const response = await this.rpcCall("free-space",{path:this.sessionArguments["download-dir"]})
      if(response.result=="success"){
        this.sessionArguments["download-dir-free-space"]=response.arguments["size-bytes"];
      }
    },60000);
  }

  async getSession(): Promise<Record<string, any>> {
    const response = await this.rpcCall("session-get")
    if(response.arguments){
      return response.arguments;
    }
    else {
      return {}
    }
  }

  getSessionArgument(arg: string): Promise<any> {
    return new Promise( (resolutionFunc,rejectionFunc) => {
      let count=0;
      const interval = setInterval(() => {
        if(this.sessionArguments && typeof this.sessionArguments[arg]!="undefined"){
          resolutionFunc(this.sessionArguments[arg]);
        }
        else if(count>=100){
          clearInterval(interval);
          rejectionFunc();
        }
        count++;
      },50);
    });
  }

  setSession(args: Record<string, any>): Promise<Record<string, any>> {
    return new Promise((resolutionFunc,rejectionFunc) => {
      this.rpcCall("session-set", args)
        .then((response) => {
          for (const key in args) {
            this.sessionArguments[key]=args[key];
          }
          resolutionFunc(response);
        })
        .catch(() => rejectionFunc())
    });
  }

  async getToken(): Promise<string> {
    let token="";
    if(this.sessionToken){
      token = this.sessionToken
    }
    else {
      const rep = await this.request("")

      if(rep.errorMessage){
        throw Error(rep.errorMessage);
      }
      else if(rep.status==401) {
        throw Error("Unauthorized");
      }

      token = this.readToken(rep);

      if(token!="") {
        this.sessionToken=token;
      }
      else {
        throw Error("Unable to reach Transmission Daemon");
      }
    }
    return token;
  }

  readToken(rep: Record<string,any>): string{
    let token="";
    if(rep.headers && typeof rep.headers['x-transmission-session-id'] !== "undefined"){
      token = rep.headers['x-transmission-session-id'];
    }
    else if(rep.headers && rep.headers.get && rep.headers.get('x-transmission-session-id')!=null){
      token = rep.headers.get('x-transmission-session-id');
    }
    return token;
  }

  async getTorrents() {
    let result: any={};
    let loadPersistent=false;
    const args = {
      fields: [
        'id',
        'name',
        'percentDone',
        'uploadRatio',
        'rateDownload',
        'rateUpload',
        'downloadedEver',
        'uploadedEver',
        'totalSize',
        'addedDate',
        'status',
        'errorString',
        'activityDate',
        'sizeWhenDone',
        'eta',
        'recheckProgress'
      ]
    }

    if(!this.persistentDataValid){
      loadPersistent=true;
      args.fields.push('trackers','downloadDir');
    }

    const response = await this.rpcCall("torrent-get", args)

    if(response.arguments){
      result=response.arguments.torrents

      if(loadPersistent){
        this.readPersitentData(result);
      }
    }
    return result
  }

  readPersitentData(details: any) {
    const trackers: Array<Record<string,any>> = [];
    const downloadDirList: Array<string> = [];

    for (const torrent of details) {

      const dir = this.readDownloadDir(torrent.downloadDir)

      if(!downloadDirList.includes(dir)){
        downloadDirList.push(dir)
      }

      let trId=0;
      for(const tracker of torrent.trackers){
        const data = this.readTracker(trId,tracker)
        if(data){
          if(!trackers[data.announce]){
            trackers[data.announce] = data;
            trId++;
          }
          if(!trackers[data.announce].ids.includes(torrent.id)){
            trackers[data.announce].ids.push(torrent.id)
          }
        }
        
      }
    }
    
    downloadDirList.sort();

    this.persistentData = {
      trackers: Object.values(trackers),
      downloadDir: downloadDirList
    }
    this.persistentDataValid = true;
  }

  readDownloadDir(downloadDir: string): string {
    let result = downloadDir
    //eslint-disable-next-line
    if(result.match(/[\/\\]$/)){
      // Remove last / or \
      result = result.substring(0,result.length-1);
    }
    return result;
  }

  readTracker(id:number, tracker: Record<string,any>): Record<string,any>|null {
    let result: Record<string,any>|null = null;
    //eslint-disable-next-line
    const matchs = tracker.announce.match(/^[\w]+:\/\/[\w\d\.-]+/);
    if(matchs){
      const tr = matchs[0];
      result = {
        id:id,
        announce:tr,
        ids:[]
      }
    }
    return result;
  }

  invalidatePersitentData() {
    this.persistentDataValid = false;
  }

  async getTorrentDetails(id: number) {
    let result: any={};
    const args = {
      ids:id,
      fields: [
        'id',
        'name',
        'percentDone',
        'uploadRatio',
        'rateDownload',
        'rateUpload',
        'downloadedEver',
        'uploadedEver',
        'totalSize',
        'addedDate',
        'status',
        'errorString',
        'activityDate',
        'sizeWhenDone',
        'leftUntilDone',
        'downloadDir',
        'comment',
        'creator',
        'dateCreated',
        'magnetLink',
        'hashString',
        'secondsDownloading',
        'secondsSeeding',
        'pieceCount',
        'pieceSize',
        'files',
        'fileStats',
        'doneDate',
        'downloadLimit',
        'downloadLimited',
        'uploadLimit',
        'uploadLimited',
        'peer-limit',
        'seedRatioLimit',
        'seedRatioMode',
        'seedIdleLimit',
        'seedIdleMode',
        'bandwidthPriority',
        'trackers',
        'trackerStats',
        'peers',
        'recheckProgress'
      ]
    }

    const response = await this.rpcCall("torrent-get", args)


    if(response.arguments && response.arguments.torrents.length > 0){
      result=response.arguments.torrents[0]
    }
    else {
      throw Error("Torrent not found");
    }

    return result;
  }

  async torrentAction(action: string, torrentId: number|Array<number>, args: Record<string, any> = {}){
    if(action=="remove"){
      this.invalidatePersitentData();
    }
    return this.rpcCall("torrent-"+action, Object.assign({ids:torrentId}, args))
  }

  async torrentAdd(args: Record<string, any> = {}){
    this.invalidatePersitentData();
    return this.rpcCall("torrent-add", args);
  }

  async rpcCall(method: string, args: Record<string, any> = {}, retry=true) {
    let ret: Record<string, any>={};
    const token = await this.getToken()

    const response = await this.request(method,token,args);

    if(response.errorMessage){
      throw Error(response.errorMessage);
    }

    if(response.status){
      if(response.status===200){
        ret = response.data;
      }
      else if(response.status===409){
        // Invalid token 
        this.sessionToken=this.readToken(response);
        if(retry){
          // Try with the new token
          ret = this.rpcCall(method,args,false);
        }
        else {
          throw Error("Invalid token");
        }
      }
      else {
        throw Error("HTTP "+response.status);
      }
    }
    return ret;
  }

  async request(action: string, token?: string, args: Record<string, any> = {}) {
    let ret: Record<string, any>={};

    const requestId = ++this.lastRequestId;
    const headers = this.getHeaders();
    const requestUrl = this.getRequestUrl();

    if(token){
      headers["X-Transmission-Session-Id"]=token;
    }

    const datas = {
      method:action,
      arguments:args,
      tag:requestId
    }

    const options = {
      method: "post" as Method,
      headers:headers,
      serializer:"json" as Serializer,
      timeout:parseInt(this.options.timeout),
      data:{},
      body:null as string|null
    }

    if(this.useNativePlugin){
      ret = await this.nativePluginRequest(requestUrl,options,datas);
    }
    else if(window.net){
      ret = await this.electronRequest(options,datas);
    }
    else {
      ret = await this.browserRequest(requestUrl,options,datas);
    }

    // Don't return result if tags doesn't match or server has been changed
    if((ret.data && ret.data.tag!=requestId) || (ret.url && ret.url!=this.getRequestUrl())){
      throw Error();
    }

    // Don't report error if there's a more recent request
    if(ret.errorMessage && requestId<this.lastRequestId){
      throw Error();
    }

    return ret;
  }

  async nativePluginRequest(requestUrl: string, options: any, datas: Record<string, any>) {
    // HTTP request using @ionic-native/http (allow CORS)
    let result: Record<string, any>={};
    options.data = datas

    await this.timeout(this.options.timeout*1000, HTTP.sendRequest(requestUrl,options))
      .then((response) => {
        result=response as Record<string, any>;
      })
      .catch((error) => {
        if(error.status){
          result=error as Record<string, any>;
        }
        else {
          result.errorMessage=error;
        }
      });

    if(result.data){
      result.data = JSON.parse(result.data)
    }

    return result;
  }

  async electronRequest(options: any, datas: Record<string, any>) {
    // HTTP request using Electron net (allow CORS)
    let result: Record<string, any>={};

    Object.assign(options,{
      hostname:this.options.host,
      port:this.options.port,
      path:this.options.path,
      protocol:this.options.https ? "https:" : "http:"
    })

    await this.timeout(this.options.timeout*1000, window.net.request(options, datas))
      .then((response: any) => {
        result=response;
      })
      .catch((error) => {
        if(error.status){
          result=error;
        }
        else if(error){
          result.errorMessage=error;
        }
      });

    return result;
  }

  async browserRequest(requestUrl: string, options: any, datas: Record<string, any>) {
    // HTTP request using fetch (no CORS)
    let result: Record<string, any>={};
    options.body = JSON.stringify(datas);

    await this.timeout(this.options.timeout*1000, fetch(requestUrl,options))
      .then((response) => {
        result=response as Record<string, any>;
      })
      .catch((error) => {
        result.errorMessage=(error=="TypeError: Failed to fetch") ? "Unable to reach host" : error;
      });

    if(result.json && result.ok){
      result.data = await result.json();
    }

    return result;
  }

  getRequestUrl(): string {
    let result = this.options.https ? "https":"http";
    result += "://"+this.options.host+":"+this.options.port+this.options.path;
    return result;
  }

  getHeaders(headers: any = {}) {
    if(this.options.auth){
      const auth = "Basic "+Buffer.from(this.options.auth.username+':'+this.options.auth.password).toString('base64');
      headers["Authorization"]=auth;
    }
    headers["Content-Type"]="application/json";
    return headers;
  }

  timeout(ms: number, promise: Promise<any>) {
    return new Promise(function(resolve, reject) {
      setTimeout(function() {
        reject("Unable to reach host (timeout)")
      }, ms)
      promise.then(resolve, reject)
    })
  }
}

export const TransmissionRPC = new TRPC();