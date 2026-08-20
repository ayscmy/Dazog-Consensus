# -*- coding: utf-8 -*-
import subprocess, json, re, time

UA = "Mozilla/5.0"
# 品种表: (小写前缀, 中文名, 交易所, 类别)
VARIETIES = [
    # 上期所 贵金属/有色/黑色/能源/化工
    ("ag","沪银","SHFE","贵金属"),("au","沪金","SHFE","贵金属"),
    ("cu","沪铜","SHFE","有色金属"),("al","沪铝","SHFE","有色金属"),
    ("zn","沪锌","SHFE","有色金属"),("pb","沪铅","SHFE","有色金属"),
    ("ni","沪镍","SHFE","有色金属"),("sn","沪锡","SHFE","有色金属"),
    ("rb","螺纹钢","SHFE","黑色系"),("hc","热卷","SHFE","黑色系"),
    ("ss","不锈钢","SHFE","黑色系"),("fu","燃油","SHFE","能源"),
    ("bu","沥青","SHFE","能源"),("lu","低硫燃油","SHFE","能源"),
    ("ru","橡胶","SHFE","化工"),("nr","20号胶","SHFE","化工"),
    ("sp","纸浆","SHFE","化工"),("sh","烧碱","SHFE","化工"),
    # 大商所 黑色/能源/化工/农产品
    ("i","铁矿石","DCE","黑色系"),("j","焦炭","DCE","黑色系"),
    ("jm","焦煤","DCE","黑色系"),("pg","液化石油气","DCE","能源"),
    ("l","塑料","DCE","化工"),("pp","聚丙烯","DCE","化工"),
    ("eg","乙二醇","DCE","化工"),("eb","苯乙烯","DCE","化工"),
    ("m","豆粕","DCE","农产品"),("y","豆油","DCE","农产品"),
    ("a","豆一","DCE","农产品"),("b","豆二","DCE","农产品"),
    ("c","玉米","DCE","农产品"),("cs","玉米淀粉","DCE","农产品"),
    ("jd","鸡蛋","DCE","农产品"),("lh","生猪","DCE","农产品"),
    ("rr","粳米","DCE","农产品"),
    # 郑商所 黑色/化工/农产品
    ("sf","硅铁","CZCE","黑色系"),("sm","锰硅","CZCE","黑色系"),
    ("ta","PTA","CZCE","化工"),("ma","甲醇","CZCE","化工"),
    ("ur","尿素","CZCE","化工"),("pf","短纤","CZCE","化工"),
    ("sa","纯碱","CZCE","化工"),("fg","玻璃","CZCE","化工"),
    ("px","对二甲苯","CZCE","化工"),("pr","瓶片","CZCE","化工"),
    ("rm","菜粕","CZCE","农产品"),("oi","菜油","CZCE","农产品"),
    ("sr","白糖","CZCE","农产品"),("cf","棉花","CZCE","农产品"),
    ("cy","棉纱","CZCE","农产品"),("ap","苹果","CZCE","农产品"),
    ("cj","红枣","CZCE","农产品"),("pk","花生","CZCE","农产品"),
    ("rs","菜籽","CZCE","农产品"),("wh","强麦","CZCE","农产品"),
    ("pm","普麦","CZCE","农产品"),("er","早籼稻","CZCE","农产品"),
    ("lr","晚籼稻","CZCE","农产品"),("jr","粳稻","CZCE","农产品"),
    # 上期能源
    ("sc","原油","INE","能源"),
    # 中金所 股指/国债
    ("IF","沪深300股指","CFFEX","股指"),("IC","中证500股指","CFFEX","股指"),
    ("IH","上证50股指","CFFEX","股指"),("IM","中证1000股指","CFFEX","股指"),
    ("T","10年国债","CFFEX","国债"),("TF","5年国债","CFFEX","国债"),
    ("TS","2年国债","CFFEX","国债"),("TL","30年国债","CFFEX","国债"),
    # 航运
    ("ec","集运指数(欧线)","SHFE","航运"),
]

MONTHS = ["2609","2610","2611","2612","2608"]

def sina_live(codes):
    """批量取新浪实时，返回 {code: 价格或None}"""
    if not codes: return {}
    url = "https://hq.sinajs.cn/list=" + ",".join(codes)
    out = subprocess.run(["curl","-s","-m","20","-A",UA,
                          "-H","Referer: https://finance.sina.com.cn",url],
                         capture_output=True).stdout.decode("gbk","ignore")
    res = {}
    for m in re.finditer(r'var hq_str_([^=]+)="([^"]*)"', out):
        code, body = m.group(1), m.group(2)
        parts = body.split(",")
        if len(parts) > 6 and re.match(r'^-?\d+(\.\d+)?$', parts[6].strip() or ""):
            res[code] = float(parts[6])
        else:
            res[code] = None
    return res

# 构造所有待验证 code
all_main = []   # 主连
all_dom_cand = []  # 主力候选
for pre, name, exch, kind in VARIETIES:
    main_code = "nf_" + pre.upper() + "0"
    all_main.append((pre, name, exch, kind, main_code))
    for mo in MONTHS:
        all_dom_cand.append((pre, name, exch, kind, "nf_"+pre.upper()+mo, mo))

# 批量验证主连
main_codes = [x[4] for x in all_main]
main_valid = {}
for i in range(0, len(main_codes), 30):
    chunk = main_codes[i:i+30]
    r = sina_live(chunk)
    main_valid.update(r)
    time.sleep(0.2)

# 批量验证主力候选 (每个品种挑第一个有效)
dom_codes = [x[4] for x in all_dom_cand]
dom_valid = {}
for i in range(0, len(dom_codes), 30):
    chunk = dom_codes[i:i+30]
    r = sina_live(chunk)
    dom_valid.update(r)
    time.sleep(0.2)

# 组装结果
futures = []
for pre, name, exch, kind, main_code in all_main:
    if main_valid.get(main_code) is None:
        # 主连无效则跳过该品种
        print("跳过(主连无效):", name, main_code)
        continue
    # 找主力: 按 MONTHS 顺序取第一个有效
    dom_code = None; dom_month = None
    for mo in MONTHS:
        c = "nf_"+pre.upper()+mo
        if dom_valid.get(c) is not None:
            dom_code = c; dom_month = mo; break
    rec = {
        "underlying": pre, "name": name, "exch": exch, "kind": kind,
        "main": {"code": main_code, "name": name+"主连"},
    }
    if dom_code:
        rec["dominant"] = {"code": dom_code, "name": name+dom_month}
    futures.append(rec)

print("有效期货品种数:", len(futures))
# 保护：有效品种过少（<40，说明接口异常/限流）时不覆盖，避免清空清单
if len(futures) < 40:
    print(f"⚠️ 有效品种数异常（{len(futures)} < 40），可能被限流，保留现有 futures.json 不覆盖")
else:
    with open("futures.json","w",encoding="utf-8") as f:
        json.dump(futures, f, ensure_ascii=False, indent=2)
    print("已写入 futures.json")
    # 打印几条样例
    for r in futures[:3]:
        print(" ", r["name"], r["main"]["code"], "->", r.get("dominant",{}).get("code"))
