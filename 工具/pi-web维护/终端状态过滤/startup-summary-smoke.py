import fcntl,json,os,pty,re,select,signal,struct,subprocess,tempfile,termios,time
from pathlib import Path
ansi=re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)')
with tempfile.TemporaryDirectory(prefix='pi-startup-summary-') as tmp:
    root=Path(tmp); agent=root/'agent'; agent.mkdir()
    (agent/'settings.json').write_text(json.dumps({'quietStartup':False}))
    for i in range(8):
        p=agent/'skills'/f'summary-skill-{i}'/'SKILL.md';p.parent.mkdir(parents=True)
        p.write_text(f'---\nname: summary-skill-{i}\ndescription: Isolated display fixture {i}\n---\nNo model request.\n')
    p=agent/'prompts'/'summary-prompt.md';p.parent.mkdir();p.write_text('---\ndescription: Display fixture\n---\nFixture only.\n')
    ext=root/'summary-extension.ts';ext.write_text('export default function (pi) {}\n')
    context=root/'summary-context.md';context.write_text('Display smoke fixture.\n')
    env={**os.environ,'HOME':str(root),'PI_CODING_AGENT_DIR':str(agent),'TERM':'xterm-256color','LANG':'en_US.UTF-8'}
    master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',45,140,0,0))
    proc=subprocess.Popen(['pi','--offline','--no-session','--no-extensions','-e',str(ext),'--no-mcp','--no-themes','--no-context-files','--append-system-prompt',str(context),'--provider','openai-codex','--model','gpt-6.1-sol'],cwd=root,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
    os.close(slave)
    def collect(seconds):
        output=bytearray(); end=time.monotonic()+seconds
        while time.monotonic()<end:
            ready,_,_=select.select([master],[],[],0.1)
            if ready:
                try: chunk=os.read(master,65536)
                except OSError: break
                if not chunk: break
                output.extend(chunk)
        return ansi.sub('',output.decode('utf8','replace'))
    try:
        collapsed=collect(5)
        assert re.search(r'Skills\s+8\s+summary-skill-0 · summary-skill-1 · summary-skill-2\s+… \+5',collapsed),repr(collapsed[-5000:])
        for label in ('Context','Prompts','Extensions'): assert label in collapsed,(label,repr(collapsed[-5000:]))
        assert 'summary-skill-7' not in collapsed,'Full list leaked into collapsed view'
        os.write(master,b'\x0f');expanded=collect(1)
        assert 'summary-skill-7' in expanded,repr(expanded[-5000:])
        os.write(master,b'\x0f');recollapsed=collect(1)
        assert re.search(r'Skills\s+8\s+summary-skill-0',recollapsed),repr(recollapsed[-5000:])
        assert 'Failed to load extension' not in collapsed and 'Extension error' not in collapsed
        print(json.dumps({'result':'PASS','executable':'/opt/homebrew/bin/pi','checks':['four category summaries','8 skills show 3 previews plus 5 remaining','Ctrl+O expands full paths including final skill','Ctrl+O collapses again'],'modelRequests':0},ensure_ascii=False,indent=2))
    finally:
        if proc.poll() is None:
            os.write(master,b'/quit\r');collect(0.5)
        if proc.poll() is None: os.killpg(proc.pid,signal.SIGTERM)
        try:proc.wait(timeout=3)
        except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait()
        os.close(master)
