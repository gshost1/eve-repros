import json,os,sys,glob
for seed in sys.argv[1:]:
    D=f"{seed}/eve-state/.workflow-data"
    if not os.path.isdir(D): print(seed,"no state"); continue
    # failed runs
    for rf in glob.glob(f"{D}/runs/*.json"):
        try: r=json.load(open(rf))
        except Exception: continue
        if r.get("status")!="failed": continue
        rid=r["runId"]; err=json.dumps(r.get("error",""))[:80]
        print(f"\n== {seed} failed run {rid} {r.get('workflowName')} err={err}")
        evs=[]
        tmps=[]
        for ef in sorted(set(glob.glob(f"{D}/events/{rid}/*"))):
            if os.path.isdir(ef): continue
            try: e=json.load(open(ef))
            except Exception: e=None
            if ".tmp." in ef:
                tmps.append((os.path.basename(ef).split("-evnt_")[1][:26][-3:], e["eventType"]+"/"+e.get("correlationId","") if e else "unreadable(0-byte?)"))
                continue
            if e is None: evs.append(("??",os.path.basename(ef),"unreadable","")); continue
            evs.append((e["eventId"],e["eventType"],e.get("correlationId",""),e.get("createdAt","")))
        for e in sorted(evs): print("  ",e[0][-3:],e[1],e[2],e[3])
        for t in tmps: print("   leftover staged .tmp at slot",t[0],":",t[1])
        published={e[2] for e in evs if e[1]=="hook_created"}
        for cf in glob.glob(f"{D}/hooks/tokens/*.json"):
            try: c=json.load(open(cf))
            except Exception: continue
            if c.get("runId")!=rid: continue
            occ=[e for e in evs if e[0]==c.get("eventId")]
            st="PUBLISHED" if c.get("hookId") in published else "MISSING"
            print(f"   claim {c.get('hookId')} token={c.get('token')[:60]} eventId={c.get('eventId','')[-3:]} {st} slot-occupant={occ[0][1]+'/'+occ[0][2] if occ else None}")
