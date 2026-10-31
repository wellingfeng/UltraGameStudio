use super::*;
use tiny_http::{Header, Response, Server};

fn config(url: String) -> ServerConfig {
    ServerConfig {id:"fixture".into(),transport:"streamable-http".into(),url:Some(url),command:None,args:None,env:None,headers:None}
}

fn tool(name:&str)->Value {
    json!({"name":name,"description":"真实测试工具","inputSchema":{"type":"object","$defs":{"item":{"type":"string"}},"properties":{"q":{"$ref":"#/$defs/item"}}},"outputSchema":{"type":"object"},"_meta":{"fixture":true}})
}

fn serve(pages:Vec<Value>,sse:bool) -> (String,std::thread::JoinHandle<Vec<String>>) {
    let server=Server::http("127.0.0.1:0").unwrap();
    let url=format!("http://{}/mcp",server.server_addr());
    let handle=std::thread::spawn(move||{
        let mut methods=Vec::new();let mut index=0;
        loop {
            let Some(mut request)=server.recv_timeout(Duration::from_secs(10)).unwrap() else {panic!("fixture 请求超时")};
            if request.method()==&tiny_http::Method::Delete {request.respond(Response::empty(204)).unwrap();break;}
            let mut text=String::new();request.as_reader().read_to_string(&mut text).unwrap();
            let message:Value=serde_json::from_str(&text).unwrap();let method=message["method"].as_str().unwrap().to_owned();
            methods.push(method.clone());
            if method=="notifications/initialized" {assert_eq!(methods,vec!["initialize","notifications/initialized"]);request.respond(Response::empty(202)).unwrap();continue;}
            let result=if method=="initialize" {json!({"protocolVersion":"2025-11-25","serverInfo":{"name":"fixture","version":"1"},"capabilities":{"tools":{"listChanged":true}}})}
                else {assert_eq!(method,"tools/list");assert!(methods.contains(&"notifications/initialized".to_owned()));
                    assert!(request.headers().iter().any(|h|h.field.equiv("Mcp-Session-Id")&&h.value.as_str()=="fixture-session"));
                    assert!(request.headers().iter().any(|h|h.field.equiv("MCP-Protocol-Version")&&h.value.as_str()=="2025-11-25"));
                    if index>0 {assert_eq!(message["params"]["cursor"],format!("page-{index}"));}
                    let value=pages[index].clone();index+=1;value};
            let reply=json!({"jsonrpc":"2.0","id":message["id"],"result":result});
            let body=if sse {format!("event: message\ndata: {reply}\n\n")}else{reply.to_string()};
            let response=Response::from_string(body).with_header(Header::from_bytes("Content-Type",if sse {"text/event-stream"}else{"application/json"}).unwrap())
                .with_header(Header::from_bytes("Mcp-Session-Id","fixture-session").unwrap());
            request.respond(response).unwrap();
        }
        methods
    });
    (url,handle)
}

#[test]
fn http_json_and_sse_handshake_pagination_preserve_schema() {
    for sse in [false,true] {
        let pages=vec![json!({"tools":[tool("a")],"nextCursor":"page-1"}),json!({"tools":[tool("b")],"nextCursor":"page-2"}),json!({"tools":[tool("c")]})];
        let (url,worker)=serve(pages,sse);
        let result=probe(Path::new("."),&config(url),None);
        assert!(result.ok,"{}",result.message);assert_eq!(result.tools_count,Some(3));assert_eq!(result.catalog_coverage,"full");
        assert_eq!(result.tools[0]["inputSchema"]["properties"]["q"]["$ref"],"#/$defs/item");
        assert_eq!(result.tools[0]["_meta"]["fixture"],true);
        assert_eq!(worker.join().unwrap(),["initialize","notifications/initialized","tools/list","tools/list","tools/list"]);
    }
}

#[test]
fn invalid_tools_is_not_zero_and_partial_is_not_full() {
    let (url,worker)=serve(vec![json!({"notTools":[]})],false);
    let result=probe(Path::new("."),&config(url),None);
    assert!(!result.ok);assert_eq!(result.tools_count,None);assert_eq!(result.status,"invalid-tools");worker.join().unwrap();
    let (url,worker)=serve(vec![json!({"tools":[tool("a")],"nextCursor":"page-1"}),json!({"tools":[tool("b")],"nextCursor":"page-1"})],false);
    let result=probe(Path::new("."),&config(url),None);
    assert!(!result.ok);assert_eq!(result.status,"cursor-loop");assert_eq!(result.tools.len(),2);assert_eq!(result.catalog_coverage,"unknown");worker.join().unwrap();
}

#[test]
fn http_401_is_auth_required_not_reachable() {
    let server=Server::http("127.0.0.1:0").unwrap();let url=format!("http://{}/mcp",server.server_addr());
    let worker=std::thread::spawn(move||{server.recv().unwrap().respond(Response::empty(401)).unwrap();});
    let result=probe(Path::new("."),&config(url),None);assert!(!result.ok);assert_eq!(result.status,"auth-required");worker.join().unwrap();
}

#[test]
fn stdio_waits_for_initialize_and_keeps_stdin_open() {
    let root=std::env::temp_dir().join(format!("ugs-mcp-fixture-{}-{}",std::process::id(),crate::now_ms()));
    std::fs::create_dir_all(&root).unwrap();let script=root.join("fixture.cjs");
    std::fs::write(&script,r#"const rl=require('node:readline').createInterface({input:process.stdin});let initialized=false;let pending=false;
rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize'){pending=true;setTimeout(()=>{pending=false;console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{}}}}))},50)}
else if(m.method==='notifications/initialized'){if(pending)process.exit(8);initialized=true}
else if(m.method==='tools/list'){if(!initialized)process.exit(9);const cursor=m.params?.cursor;console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:cursor?'b':'a',inputSchema:{type:'object',$defs:{x:{type:'string'}}}}],...(cursor?{}:{nextCursor:'next'})}}))}});
rl.on('close',()=>process.exit(7));"#).unwrap();
    let server=ServerConfig {id:"stdio".into(),transport:"stdio".into(),command:Some("node".into()),args:Some(vec![script.to_string_lossy().into_owned()]),env:None,url:None,headers:None};
    let result=probe(&root,&server,None);assert!(result.ok,"{}",result.message);assert_eq!(result.tools_count,Some(2));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn cancelled_discovery_does_not_send_requests() {
    let flag=AtomicBool::new(true);
    assert_eq!(Transport::open(Path::new("."),&config("http://127.0.0.1:1/mcp".into()),&flag).err().unwrap().0,"cancelled");
}

// A legacy MCP server keeps its GET stream open after the last tools/list page.
// Watching client EOF verifies that discovery releases the socket, not just the
// catalogue receiver. Every fixture worker has a bounded lifetime and is joined.
fn legacy_fixture() -> (String, std::thread::JoinHandle<(Vec<String>, bool)>) {
    use std::net::{TcpListener, TcpStream};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/sse", listener.local_addr().unwrap());
    let worker = std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel::<Value>();
        let mut stream_worker = None;
        let mut methods = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while methods.len() < 4 && std::time::Instant::now() < deadline {
            let (stream, _) = match listener.accept() {
                Ok(pair) => pair,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Err(e) => panic!("legacy fixture accept: {e}"),
            };
            stream.set_nonblocking(false).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut reader = BufReader::new(stream);
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() { break; }
            }
            if request_line.starts_with("GET /sse ") {
                let mut stream: TcpStream = reader.into_inner();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\nevent: endpoint\r\ndata: /messages\r\n\r\n").unwrap();
                stream.flush().unwrap();
                stream.set_read_timeout(Some(Duration::from_millis(25))).unwrap();
                let replies = rx;
                stream_worker = Some(std::thread::spawn(move || {
                    let deadline = std::time::Instant::now() + Duration::from_secs(3);
                    while std::time::Instant::now() < deadline {
                        while let Ok(reply) = replies.try_recv() {
                            if write!(stream, "event: message\r\ndata: {reply}\r\n\r\n").and_then(|_| stream.flush()).is_err() { return true; }
                        }
                        match stream.read(&mut [0u8; 1]) {
                            Ok(0) => return true,
                            Err(e) if matches!(e.kind(), std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe) => return true,
                            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {},
                            _ => {},
                        }
                    }
                    false
                }));
                // The GET stream is established once; later requests are POST.
                break;
            } else { panic!("expected legacy GET, got {request_line}"); }
        }
        while methods.len() < 4 && std::time::Instant::now() < deadline {
            let (stream, _) = match listener.accept() {
                Ok(pair) => pair,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => { std::thread::sleep(Duration::from_millis(10)); continue; }
                Err(e) => panic!("legacy fixture accept: {e}"),
            };
            stream.set_nonblocking(false).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut reader = BufReader::new(stream);
            let mut line = String::new(); reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("POST /messages "), "{line}");
            let mut length = 0;
            loop {
                let mut line = String::new(); reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() { break; }
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("Content-Length") { length = value.trim().parse().unwrap(); }
                }
            }
            let mut body = vec![0; length]; reader.read_exact(&mut body).unwrap();
            let message: Value = serde_json::from_slice(&body).unwrap();
            let method = message["method"].as_str().unwrap().to_owned(); methods.push(method.clone());
            let result = match method.as_str() {
                "initialize" => Some(json!({"protocolVersion":"2024-11-05","serverInfo":{"name":"legacy-fixture","version":"1"},"capabilities":{"tools":{}}})),
                "notifications/initialized" => { assert_eq!(methods.len(), 2); None },
                "tools/list" => {
                    assert!(methods.contains(&"notifications/initialized".to_owned()));
                    if methods.len() == 3 { Some(json!({"tools":[tool("legacy-a")],"nextCursor":"next"})) }
                    else { assert_eq!(message["params"]["cursor"], "next"); Some(json!({"tools":[tool("legacy-b")]})) }
                },
                _ => panic!("unexpected method {method}"),
            };
            let mut stream = reader.into_inner();
            write!(stream, "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap(); stream.flush().unwrap();
            if let Some(result) = result { tx.send(json!({"jsonrpc":"2.0","id":message["id"],"result":result})).unwrap(); }
        }
        (methods, stream_worker.unwrap().join().unwrap())
    });
    (url, worker)
}

#[test]
fn legacy_sse_handshake_pagination_releases_owned_connection() {
    let (url, worker) = legacy_fixture();
    let mut server = config(url); server.transport = "sse".into();
    let result = probe(Path::new("."), &server, None);
    let (methods, disconnected) = worker.join().unwrap();
    assert!(result.ok, "{}", result.message);
    assert_eq!(result.tools_count, Some(2));
    assert_eq!(methods, ["initialize", "notifications/initialized", "tools/list", "tools/list"]);
    assert!(disconnected, "目录成功后 legacy SSE 客户端仍持有连接");
}

#[test]
fn legacy_sse_cancel_before_endpoint_releases_owned_connection() {
    use std::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/sse", listener.local_addr().unwrap());
    let (ready_tx, ready_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
                Err(e) => panic!("legacy cancellation fixture accept: {e}"),
            }
        };
        stream.set_nonblocking(false).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut reader = BufReader::new(stream);
        loop {
            let mut line = String::new(); reader.read_line(&mut line).unwrap();
            if line == "\r\n" { break; }
            assert!(!line.is_empty());
        }
        stream = reader.into_inner();
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n: waiting for endpoint\n\n").unwrap();
        stream.flush().unwrap(); ready_tx.send(()).unwrap();
        match stream.read(&mut [0u8; 1]) {
            Ok(0) => true,
            Err(e) if matches!(e.kind(), std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe) => true,
            _ => false,
        }
    });
    let flag = Arc::new(AtomicBool::new(false));
    let cancel_flag = flag.clone();
    let cancel_worker = std::thread::spawn(move || {
        ready_rx.recv_timeout(Duration::from_secs(3)).unwrap(); cancel_flag.store(true, Ordering::Relaxed);
    });
    let mut server = config(url); server.transport = "sse".into();
    let result = Transport::open(Path::new("."), &server, &flag);
    cancel_worker.join().unwrap();
    let disconnected = worker.join().unwrap();
    assert_eq!(result.err().unwrap().0, "cancelled");
    assert!(disconnected, "取消等待 endpoint 后客户端未释放 SSE 连接");
}
