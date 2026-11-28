# Leaf Bot'u sunucuda çalıştırma (Docker)

## Tek komutla kurulum

Boş bir Ubuntu (22.04 ve sonrası) ya da Debian (12 ve sonrası) sunucuda, en az 2 GB bellekle (4 GB önerilir):

```bash
curl -fsSL https://raw.githubusercontent.com/esmworks/leafbot/main/docker/install.sh | sudo bash -s -- --lang tr
```

`install.sh` sırasıyla:

1. En son sürümü `/opt/leafbot` altına indirir ve işin geri kalanını o sürümün kendi betiğine bırakır.
2. Docker'ı kurar (26 ya da sonrası gerekir).
3. `docker/.env` dosyasını rastgele parola ve anahtarlarla doldurur; yeniden çalıştırınca bunlar değişmez.
4. `apparmor.sh` ile AppArmor'u ayarlar (bkz. "AppArmor").
5. Hazır imajları indirir; o sürümün imajı yoksa sunucuda derler (10–20 dakika, 4 GB'tan az bellekte yarıda
   kalabilir).
6. Kapsayıcıları `compose.yml` ile `compose.vps.yml` birlikte başlatır. İkincisi Caddy'yi ekler; Caddy 80 ve 443
   numaralı bağlantı noktalarında dinler ve Let's Encrypt sertifikasını kendisi alıp yeniler.
7. `firewall.sh` kurallarını uygular ve her açılışta ve Docker her yeniden başladığında yeniden uygulayan
   `leafbot-firewall` systemd servisini kurar. `ufw` açıksa 80 ve 443'e izin verir.
8. Adresi ve erişim anahtarını yazar.

Alan adı verilmezse sunucunun genel IP adresinden bir ad kullanılır: `203.0.113.7` için `203-0-113-7.sslip.io`. Kurulu
bir sunucu güncellemede adını korur. Kendi alan adınız varsa önce DNS kaydını sunucuya yönlendirin, sonra
`--domain bot.example.com` verin. Sağlayıcının güvenlik duvarında 80 ve 443 açık olmalıdır.

| Seçenek                | Anlamı                                                                  |
| ---------------------- | ----------------------------------------------------------------------- |
| `--domain AD`          | Sunucunun alan adı                                                      |
| `--version vX.Y.Z`     | Kurulacak sürüm (varsayılan: en son sürüm)                              |
| `--computer`           | Botların bilgisayarını açar (8 GB önerilir); `--no-computer` kapatır    |
| `--access-key ANAHTAR` | Erişim anahtarını siz seçin (en az 24 karakter: harf, rakam, `- _ . ~`) |
| `--dir KLASÖR`         | Kurulum klasörü (varsayılan: `/opt/leafbot`)                            |
| `--lang tr`            | İletiler Türkçe                                                         |

Kurulumdan sonra aynı betik `leafbot` komutuyla çalışır:

```bash
sudo leafbot update        # en son sürüme günceller; ayarlar ve veriler kalır
sudo leafbot status        # kapsayıcılar ve sunucunun yanıtı
sudo leafbot logs [servis] # kayıtlar (leafbot, caddy, db, computer)
sudo leafbot access-key    # erişim anahtarı
sudo leafbot login         # Leaf Bot hesabınıza girip sunucuyu hesaba bağlar
sudo leafbot phone         # telefon uygulamasını ya da Chrome eklentisini bağlayan QR kod
sudo leafbot compose ...   # bu kurulumun dosyalarıyla docker compose
```

`sudo leafbot login`, masaüstü uygulamasının ilk açılışta yaptığı girişi terminalde yapar: e-posta adresinizi sorar,
o adrese bir kod gönderir, kodu (hesabın adı yoksa adınızı da) sorar, sunucuyu hesabınıza bağlar ve sunucuyu yeniden
başlatır (durdurulmuş bir sunucu bağlanır ama durmuş kalır). Ardından hesapta sunucunun sahibi sizsiniz; sunucuya telefondan ve www.leafbot.app/bots adresinden, port
açmadan ve sunucuya ayrı bir adres vermeden ulaşırsınız. Gelen kod yanlışsa yeniden yazılır; boş bırakıp Enter'a
basmak yeni bir kod gönderir.

### Hesaptan kurulum kodu ile

www.leafbot.app'te hesabınızın "Sunucu ekle" sayfası, aynı kurulum komutunu bir kurulum koduyla verir:

```bash
{ echo LEAFBOT_INSTALL_CODE=ABCDE-FGHJK-LMNPQ-RSTUV; curl -fsSL https://raw.githubusercontent.com/esmworks/leafbot/main/docker/install.sh; } | sudo bash -s
```

Kurulum bittiğinde sunucu kodu kullanıp kendiliğinden o hesaba bağlanır; e-posta ya da kod sorulmaz ve hesap
sayfası yeni sunucuyu gösterir. Kod 15 dakika geçerlidir ve bir kez kullanılır. Kod komut satırına argüman ya da sudo
değişkeni olarak yazılmaz, çünkü sudo kaydı ve `ps` ikisini de gösterir; betikten önceki satır onu betiği çalıştıran
kabuğa verir. Süresi dolmuş ya da geçersiz bir kod kurulumu durdurmaz; sunucu kurulur ve `sudo leafbot login` ile
bağlanır. Kurulu bir sunucu da aynı yolla bağlanabilir: `echo KOD | sudo leafbot compose exec -T leafbot node
dist/index.mjs login --code` ve ardından `sudo leafbot restart`.

`update` seçenek alır: `sudo leafbot update --computer` botların bilgisayarını sonradan açar.

### Sunucuyu oluştururken (cloud-init)

Hetzner, DigitalOcean, Vultr gibi sağlayıcılar sunucu oluşturma ekranında "Cloud config" ya da "User data" kutusu
verir. Oraya yapıştırılan metin kurulumu SSH'a hiç girmeden yapar:

```yaml
#cloud-config
runcmd:
  - curl -fsSL https://raw.githubusercontent.com/esmworks/leafbot/main/docker/install.sh | bash -s -- --lang tr --access-key UZUN-RASTGELE-BIR-ANAHTAR
```

Erişim anahtarını burada siz seçersiniz, çünkü betiğin çıktısı sunucuda bir kayıt dosyasına yazılır ve anahtar oraya
yazdırılmaz. Birkaç dakika sonra sunucu `https://<IP-adresi-tireli>.sslip.io` adresinde açılır. Kurulumun gidişi sunucuda
`/var/log/cloud-init-output.log` dosyasındadır.

### Ters vekil

Erişim anahtarı yalnızca sunucunun kendi bilgisayarından gelen isteklerde geçer. Ters vekilin arkasında bütün
istekler vekilin adresinden gelir; vekil tanıtılmazsa yönlendirme başlığı taşıyan her istek dışarıdan sayılır. Vekil
tanıtmak için vekil `LEAFBOT_PROXY_SECRET` değerini `X-Leafbot-Proxy` başlığında, kişinin adresini `X-Forwarded-For`
başlığında gönderir; sunucu `X-Forwarded-For`'a yalnızca bu sırla gelen isteklerde güvenir. Aynı bilgisayardaki bir
vekil sır göndermez ve yönlendirme başlığı da eklemezse, gelen her istek bu bilgisayardan sayılır ve erişim anahtarı
formu dışarıya açılır; bu yüzden vekile sırrı ve `X-Forwarded-For` başlığını mutlaka ekletin. `install.sh` bunu
kendisi ayarlar. Elle kurulan bir nginx için:

```nginx
proxy_set_header X-Leafbot-Proxy <LEAFBOT_PROXY_SECRET değeri>;
proxy_set_header X-Forwarded-For $remote_addr;
```

## Elle kurulum

```bash
cp docker/.env.example docker/.env      # değerleri doldurun
sudo ./docker/apparmor.sh --env docker/.env   # Linux ana makinede, bir kez; bkz. "AppArmor"
docker compose -f docker/compose.yml --env-file docker/.env up -d --build
sudo ./docker/firewall.sh               # Linux ana makinede, compose'dan sonra
```

Sunucu yalnızca ana makinenin `127.0.0.1:4319` adresinde dinler. Uzaktan erişim için bkz. "Uzaktan erişim".

Sunucuyu Leaf Bot hesabınıza bağlamak için `login` komutunu kapsayıcısında çalıştırın, sonra sunucuyu yeniden
başlatın:

```bash
docker compose -f docker/compose.yml --env-file docker/.env exec -e LANG=tr -e LEAFBOT_SERVER_NAME=bot.ornek.com leafbot node dist/index.mjs login
docker compose -f docker/compose.yml --env-file docker/.env restart leafbot
```

Komut sunucunun veri klasöründe (`LEAFBOT_DATA_DIR`) ve veritabanında çalışır, bu yüzden sunucu hiç başlamadan da
kullanılır. `LEAFBOT_SERVER_NAME` hesabın sunucuyu hangi adla listeleyeceğidir; verilmezse kapsayıcının kimliği
görünür. Gömülü veritabanıyla (`DATABASE_URL` yokken) çalışan bir sunucu önce durdurulmalıdır, çünkü o
veritabanını aynı anda tek bir süreç açabilir.

## Uzaktan erişim

Uygulama, telefon ve Chrome eklentisi sunucuya adresinden değil, Leaf Bot hesabı ve tünel üzerinden ulaşır; bunun
için sunucu hiçbir port açmaz, yalnızca `login` ile hesaba bağlanır. Aşağıdaki yollar sunucunun kendi web sayfasını
dışarıya açar; o sayfada erişim anahtarı geçmez, giriş Leaf Bot hesabına yönlendirir. Sunucunun genel bir adrese
yine de ihtiyacı olduğu yerler: Microsoft Teams'in mesajları gönderdiği adres ve bağlantıların (MCP, OAuth)
girişten döndüğü adres. Bunları kullanmıyorsanız aşağıdakilerin hiçbiri gerekmez.

Sunucuyu dışarıya açmanın üç yolu var; hiçbiri ana makinede bir port açmaz, ilk ikisi ters vekil de istemez.

**Cloudflare Tunnel** (herkese açık bir alan adıyla, HTTPS Cloudflare'den):

1. Cloudflare panelinde Zero Trust → Networks → Tunnels → Create a tunnel (Cloudflared) ile bir tünel açın ve
   jetonunu `.env` dosyasında `CLOUDFLARE_TUNNEL_TOKEN` değerine yazın.
2. Tünelin Public Hostname ayarına alan adınızı (ör. `bot.ornek.com`) ve servis olarak `http://leafbot:4319`
   yazın.
3. `.env` dosyasında `LEAFBOT_PUBLIC_URL=https://bot.ornek.com` ve `LEAFBOT_SECURE_COOKIES=1` yapın.
4. Vekili tanıtın (bkz. "Ters vekil"): `.env` dosyasında `LEAFBOT_PROXY_SECRET` boşsa
   `openssl rand -hex 32` ile doldurun. Cloudflare panelinde alan adınızın Rules → Transform Rules → Modify
   Request Header bölümünde bir kural açın: koşul `Hostname equals bot.ornek.com`, işlem "Set static",
   başlık `X-Leafbot-Proxy`, değer `LEAFBOT_PROXY_SECRET` değeri. Cloudflare kişinin adresini
   `X-Forwarded-For` başlığının sonuna kendisi yazar. Kural yoksa istekler dışarıdan sayılır ve erişim
   anahtarı geçmez.
5. `docker compose -f docker/compose.yml --env-file docker/.env --profile cloudflare up -d`

**Tailscale** (yalnız tailnet'inizdeki cihazlardan, `https://leafbot.<tailnet>.ts.net`):

1. Tailscale yönetim panelinde bir auth key oluşturup `.env` dosyasında `TAILSCALE_AUTHKEY` değerine yazın;
   tailnet'inizde HTTPS sertifikalarını açın (DNS → HTTPS Certificates).
2. `.env` dosyasında `LEAFBOT_PUBLIC_URL=https://leafbot.<tailnet>.ts.net` ve `LEAFBOT_SECURE_COOKIES=1` yapın.
3. `docker compose -f docker/compose.yml --env-file docker/.env --profile tailscale up -d`

Tailscale'in `serve` özelliği isteğe kendi başlığını ekleyemez, bu yüzden `X-Leafbot-Proxy` gönderilmez ve
tailnet'ten gelen istekler dışarıdan sayılır.

Tünel kapsayıcıları sunucuya yalnızca kendi iç ağlarından (`edge`) ulaşır; sunucuya oradan dışarıya yeni bir yol
açılmaz.

**Kendi ters vekiliniz** (Caddy, nginx): önüne TLS veren vekili koyun, `LEAFBOT_ALLOWED_HOSTS` değerine alan adını,
`LEAFBOT_SECURE_COOKIES=1` yazın.

## Uygulamaya giriş

Herkes kendi Leaf Bot hesabıyla girer (e-posta kodu, Google ya da Apple). Sunucuyu `login` ile hesabınıza
bağladıktan sonra www.leafbot.app/bots/ sayfası sunucuyu listeler ve tünel üzerinden açar. Başkalarını Ayarlar →
Kişiler'den e-postayla davet edin; daha önce şifreyle giren biri, kendisi için açılan davetle aynı kişi olarak
devam eder.

Telefon uygulamasını ya da Chrome eklentisini bağlamak için sunucuda şunu çalıştırıp QR kodu okutun ya da kodu
yazın; kod iki dakika, bir kez geçer:

```bash
docker compose -f docker/compose.yml --env-file docker/.env exec -e LANG=tr leafbot node dist/index.mjs phone
```

Aynı kod, oturumu açık bir cihazda Ayarlar → Bağlantı → Başka bir cihaz bağla'dan da alınır.

`.env` dosyasındaki `LEAFBOT_ACCESS_KEY` yalnızca sunucunun kendi bilgisayarından gelen isteklerde ve oradaki
betiklerde geçer; hesap hizmetine ulaşılamadığında sahibin yerel girişidir.

## Claude girişi

Claude'u uygulamadan bağlayın: ilk açılıştaki kurulumda ya da sonra Ayarlar → Bağlantı → Claude
bölümünde iki yol vardır:

- **Claude aboneliği:** Claude Code kurulu herhangi bir bilgisayarda `claude setup-token` çalıştırın,
  tarayıcıda giriş yapın ve çıkan belirteci (`sk-ant-oat…`) yapıştırın.
- **Anthropic API anahtarı:** console.anthropic.com'dan alınan anahtar; her istek ayrıca ücretlendirilir.

"Kaydet ve dene" belirteci ya da anahtarı tek bir kısa istekle dener. Değer, kasa ile aynı anahtarla
(`/data/vault.key`) şifrelenip veritabanında saklanır; uygulama yalnızca son dört karakterini gösterir.
Claude, botun çalıştırdığı komutların ortamından bu değişkenleri siler; bot belirteci okuyamaz.

Sunucunun ortamındaki `ANTHROPIC_API_KEY` kullanılmaz: kullandıkça ödemeye geçiş yalnızca uygulamadan
seçilerek olur.

Kapsayıcının içinde Claude Code ile giriş de hâlâ çalışır; uygulamada bir belirteç ya da anahtar
kayıtlıysa o kullanılır:

```bash
docker compose -f docker/compose.yml --env-file docker/.env exec -it leafbot sh -c \
  'exec $(find node_modules/.pnpm -path "*claude-agent-sdk-linux*/claude" -type f | head -1) auth login'
```

## Kapsayıcının sınırları

- Root olmayan kullanıcı (uid 10001), salt okunur kök dosya sistemi; yazılabilir yalnızca `/data` ve `tmpfs`.
- Bütün yetkiler kapalı (`cap_drop: ALL`), `no-new-privileges`, bellek, işlemci ve süreç sınırı.
- Veritabanı yalnızca iç ağda; internete çıkamaz ve ana makineye açılmaz.
- `firewall.sh`: kapsayıcıdan ev/ofis ağına, bulut gizli adreslerine ve IPv6 yerel adreslere çıkış kapalı.
  Ana makinenin kendisine de (köprünün ağ geçidi, ana makinenin yerel ya da genel adresi) yalnızca ana
  makinenin açtığı bağlantıların yanıtları gelir: ana makinede `0.0.0.0` üzerinde dinleyen bir servis
  (Ollama, veritabanı, yönetim paneli) botlara kapalıdır. Kapsayıcılar adları Docker'ın kendi çözücüsüyle
  (`127.0.0.11`) çözer, bunun için ana makinede açık bir port gerekmez. Bir botun ana makinedeki bir
  servise gerçekten ulaşması gerekiyorsa o servisi bir Docker ağına koyun; kuralı gevşetmeyin.

## Kişi başında değilken

Rutinlerin ve başka botların başlattığı turlarda açılan izin kartı ve soru, `LEAFBOT_UNATTENDED_HOURS` saat
(varsayılan 12, en çok 576) içinde yanıtlanmazsa reddedilir; bot bunu bilerek işine devam eder. Kişinin kendi
yazdığı mesajla başlayan turlarda kart süresiz bekler.

## Botların tarayıcısı

Her bot web sitelerinde iş yapmak için kendi tarayıcısını kullanır. İmajda Chromium kuruludur
(`LEAFBOT_BROWSER=/usr/bin/chromium`). Her botun ayrı bir profili `/data/browsers/<bot>` altında durur;
girişler ve çerezler orada kalır, botlar birbirinin profilini görmez.

- Tarayıcı ilk kullanımda açılır; kimse izlemiyorsa ve bot 15 dakika kullanmazsa kapanır. Aynı anda en çok
  `LEAFBOT_MAX_BROWSERS` (varsayılan 3) tarayıcı açık kalır.
- Sohbetin üstündeki bilgisayar düğmesinden ya da sağ paneldeki "Bilgisayar" bölümünden botun ekranı
  canlı izlenir. "Kontrolü al" ile tarayıcıyı siz kullanırsınız (giriş, doğrulama kodu gibi); bu sırada bot
  bekler, pencereyi kapatınca kontrol bota geri döner.
- Tarayıcıyı yalnızca interneti açık botlar kullanır (bot ayarlarında "İnternet erişimi"). Bot siteleri
  sormadan açar; bir şey gönderen, satın alan, silen ya da paylaşan bir adımdan önce onay kartı gösterir.
  Yalnızca `http` ve `https` adresleri açılır.
- Chromium'un kendi yalıtımı (sandbox) açıktır; Bash yalıtımıyla aynı kullanıcı ad alanı izinlerine
  dayanır. Çalışmadığı bir ortamda `LEAFBOT_BROWSER_SANDBOX=0` ile kapatılabilir; o zaman web sayfaları
  yalnızca kapsayıcının sınırlarıyla korunur.

### Tarayıcının çıkış adresi

Botların tarayıcısı internete varsayılan olarak sunucunun kendi adresinden çıkar. Bazı siteler (bot
korumasının arkasındaki havayolu ve bilet siteleri gibi) bir veri merkezine ait adresleri sayfa daha
açılmadan geri çevirir; tarayıcıda `ERR_HTTP2_PROTOCOL_ERROR` ya da "This site can't be reached" görünür.
İki yol var:

- **Kişinin bilgisayarı:** Ayarlardaki "Botların tarayıcısı bilgisayarımdan çıksın" açıkken ve masaüstü uygulaması
  bağlıyken tarayıcı o bilgisayarın bağlantısından çıkar. Bu her zaman önce gelir.
- **Cloudflare WARP:** Bilgisayar bağlı değilken tarayıcı sunucunun adresi yerine WARP'ın adresinden çıkar.
  WARP'ın adresleri çok sayıda kişinin cihazıyla paylaşıldığından bu siteler çoğunlukla geçirir; yine de
  geçireceği garanti değildir.

WARP'ı açmak için `docker/.env` dosyasına şunları ekleyin:

```
LEAFBOT_WARP=1
LEAFBOT_EGRESS_PROXY=socks5://leafbot-warp:1080
```

Ardından kapsayıcıları yeni ayarla yeniden oluşturun. `docker/install.sh` ile kurulan sunucuda:

```bash
leafbot compose up -d
```

Kurulum betiği olmadan compose'u elle çalıştırıyorsanız `up -d` komutuna `--profile warp` ekleyin
(`leafbot restart` yetmez; yeni servisi başlatmaz ve ayarı kapsayıcılara geçirmez). `warp` servisi ilk açılışta Cloudflare'in ücretsiz WARP
hizmetine bir kayıt açar ve kayıt `warp` biriminde saklanır. Bu adımda Cloudflare'in WARP kullanım
koşulları kabul edilmiş olur. Servise yalnızca sunucu ve botların bilgisayarı ulaşır; interneti açık bir
botun masaüstündeki komutlar da buna dahildir. Servisin kendi çıkışı da `docker/firewall.sh` kurallarının
arkasındadır, bu yüzden WARP üzerinden de özel adreslere ulaşılmaz.

Kontrol etmek için bota `https://tls.peet.ws/api/all` adresini açtırın: `ip` satırında artık sunucunun
adresi değil bir Cloudflare adresi görünmelidir.

- Adresler yine sunucuda denetlenir; WARP üzerinden de yerel ağa ve özel adreslere ulaşılmaz.
- `LEAFBOT_BROWSER_LOCAL_HOSTS` içindeki adresler WARP'a gitmez, doğrudan bağlanır.
- `warp` servisine ulaşılamazsa tarayıcı eskisi gibi sunucunun adresinden çıkar ve günlüğe
  `browser proxy: … leaving from here` yazılır. WARP açık olduğu hâlde bir siteye ulaşamıyorsa bağlantı
  sunucudan yeniden denenmez; hata o sitenin hatası olarak görünür.
- Git ve botların diğer internet istekleri bu ayardan etkilenmez.

### Şifre kasası

Bir siteye giriş gerektiğinde bot sohbette bir giriş kartı açar; kullanıcı adı ve şifreyi siz yazarsınız,
sunucu bunları doğrudan o siteye yazar. Bot şifreyi hiç görmez: sayfa taslağında şifre alanlarının ve
kasadaki şifrelerin yeri `••••••` olarak gelir. "Kasaya kaydet" seçilirse bilgi Ayarlar → Kasa'da durur ve
bir dahaki girişte kart açılmaz. Kayıtlı bir giriş yalnızca kaydedildiği siteye ve alt alan adlarına
yazılır.

Şifreler veritabanında AES-256-GCM ile şifrelenir; anahtar `/data/vault.key` dosyasındadır. Yedek alırken
bu dosyayı da alın: anahtar olmadan kasadaki şifreler açılamaz. Veritabanı yedeğini anahtardan ayrı
saklamak, yedek ele geçse de şifreleri korur.

Masaüstü uygulamasında ayrıca kurulum gerekmez: bilgisayarda kurulu Chrome, Edge ya da Chromium bulunur
ve botlar onu kendi ayrı profilleriyle kullanır. Durum Ayarlar → Bağlantı → "Botların tarayıcısı"
satırında görünür.

## Web araması

Claude botları web'de kendi aracıyla arar. API anahtarıyla çalışan botlar (OpenAI, Gemini, OpenRouter gibi)
için bir SearXNG kurulumu verilirse onlar da arar; verilmezse yalnızca sayfa okuyabilir, aramayı tarayıcıyla
yapar. Adres `docker/.env` içindeki `WEB_SEARCH_URL` ile verilir:

```bash
WEB_SEARCH_URL=http://searxng:8080
```

- SearXNG'nin JSON çıktısı açık olmalı: `settings.yml` içinde `search.formats` listesine `json` eklenir.
  Kapalıysa bot "arama hizmeti JSON vermiyor" der.
- `leafbot` kapsayıcısı SearXNG'ye bir Docker ağı üzerinden ulaşmalı; adres o ağdaki kapsayıcı adıdır. Bu
  ağ panelin bütün uygulamaları bağlayan ortak ağı (Dokploy'da `dokploy-network`) olmamalı: sunucu o ağa
  girince güvenlik duvarının dışında kalır (bkz. "Dokploy ve benzeri paneller"). Yalnızca SearXNG'nin
  bulunduğu ayrı bir ağ kullanın; bkz. "Kendi model servisleriniz". Adres sunucunun kendi ayarı olduğu için özel ağda olabilir; botların
  okuduğu sayfalar ise yalnızca internetteki herkese açık adreslerden okunur.
- Arama ve sayfa okuma yalnızca interneti açık botlarda vardır ve Claude botlarının aynı adımlarıyla aynı
  izin kurallarına bağlıdır.

## Kendi model servisleriniz

Konuşmayı yazıya çevirme (Whisper), seslendirme (Kokoro, speaches), anlama göre hafıza araması (Ollama) ve
web araması (SearXNG) bu kurulumun dışında, aynı sunucuda çalışan servislerde olabilir. Ayarlar → Yapay zekâ
servisleri'ndeki adres (ör. `http://whisper:8000/v1`) o servisin bir Docker ağındaki adıdır, ve sunucu
kapsayıcısı ona ancak aynı ağdaysa ulaşır. Ulaşamazsa ses "servise ulaşılamadı: EAI_AGAIN" der, hafıza
dizinlenmez.

Panelin ortak ağı (Dokploy'da `dokploy-network`) bunun için kullanılmaz: sunucu o ağa girince güvenlik
duvarının dışında kalır ve paneldeki bütün uygulamalara ulaşır. Elle `docker network connect` ile
bağlamak da kalıcı olmaz; bir sonraki yayın bağlantıyı düşürür. Bunun yerine yalnızca bu servislerin
bulunduğu ayrı bir ağ açın ve kurulumun ortam değişkenlerinde adını verin:

```bash
docker network create --driver overlay --attachable leafbot-services
```

```bash
LEAFBOT_SERVICES_NETWORK=leafbot-services
```

- Ağ, paneldeki servisler Swarm servisiyse (Dokploy'un "Application" ve veritabanı servisleri) `overlay`
  ve `--attachable` olmalı; yalnızca compose ile çalışan bir sunucuda düz bir köprü ağı da olur.
- Servisler de bu ağa girer. Swarm servisi için `docker service update --network-add leafbot-services
<servis>`; compose ile çalışan bir servis (ör. SearXNG) kendi compose dosyasında ağı `external: true`
  olarak tanımlar ve servisin `networks` listesine ekler. Servisin öteki ağları yerinde kalır.
- Aynı sunucudaki birden çok kurulum aynı ağı paylaşabilir.
- Değişken verilmezse compose kuruluma ait boş ve internete kapalı bir ağ açar; hiçbir şey değişmez.
  `docker compose down` dışarıdan verilen ağı silmez.

## Bash yalıtımı

Botların Bash komutları (Claude botlarının ve API anahtarıyla çalışan botların) kapsayıcının içinde ayrıca
bir yalıtımda (bubblewrap) çalışır. Bu ikinci
kat gereklidir: bütün botlar aynı `/data` klasörünü paylaşır ve orada Claude girişi, erişim anahtarı ve
öteki botların dosyaları durur. Yalıtımın içindeki komut yalnızca kendi botunun klasörlerini görür; kendi
süreç ad alanında çalıştığı için sunucunun ve kapsayıcının süreçlerini (ve ortam değişkenlerini) de görmez.
Yalıtım kurulamazsa sunucu komutu yalıtımsız çalıştırmaz.

bubblewrap'in kapsayıcıda çalışması için `compose.yml` iki ayar verir:

- `seccomp=./seccomp.json`: Docker'ın varsayılan seccomp profili, artı kullanıcı ad alanı ve bağlama için
  beş çağrı (`clone`, `unshare`, `mount`, `umount2`, `pivot_root`). Öteki bütün kurallar varsayılandaki
  gibidir. Dosyayı yeniden üretmek için: `node docker/seccomp.mjs`. Varsayılan profil Docker'ın
  `moby/profiles` deposundandır (Apache-2.0).
- `systempaths=unconfined`: Docker'ın `/proc` üzerindeki maskelerini kaldırır; bubblewrap yalıtıma yeni bir
  `/proc` bağlayabilsin diye. Sunucu root olmayan kullanıcıyla, bütün yetkiler kapalı ve `no-new-privileges`
  ile çalıştığı için maskelerin koruduğu çekirdek dosyalarına (ör. `/proc/sysrq-trigger`, `/proc/kcore`)
  yine yazamaz ve onları okuyamaz.

Bedeli: kapsayıcının içindeki süreçler kullanıcı ad alanı açabilir; bu, çekirdeğin daha geniş bir yüzeyini
kullanıma açar. Kapsayıcının kendi sınırları (root olmayan kullanıcı, bütün yetkiler kapalı,
`no-new-privileges`, salt okunur kök) yerinde kalır; gevşeyen yalnızca şunlardır:

| Ayar                                     | Neden gerekli                                                                                                                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seccomp.json`: `clone`, `unshare`       | Yalıtımın kendi kullanıcı, süreç ve bağlama ad alanları                                                                                                                                                          |
| `mount`, `umount2`, `pivot_root`         | Yalıtımın dosya sistemini (yalnızca botun klasörleri) kurmak                                                                                                                                                     |
| `chroot`                                 | Chromium'un kendi yalıtımı                                                                                                                                                                                       |
| `systempaths=unconfined`                 | Yalıtım kendi süreç ad alanına yeni bir `/proc` bağlar; çekirdek bunu, kapsayıcının `/proc`'unun bir kısmı Docker'ın maskeleriyle örtülüyken reddeder. Eski `/proc`'u kullanmak sunucunun süreçlerini gösterirdi |
| AppArmor `unconfined` / `leafbot-userns` | `docker-default` bağlamaları reddeder; aşağıya bakın                                                                                                                                                             |

Bağlamaları tek tek sayan daraltılmış bir AppArmor profili verilmedi: bubblewrap'in yaptığı bağlamalar
sürümden sürüme değişir ve profil denenmeden gönderilirse yalıtım, dolayısıyla Claude botlarının Bash'i,
sessizce çalışmaz olur. Yalıtım yine de bu katmanlardan bağımsız olarak botu kendi klasörlerine sınırlar.

Ana makine için öneriler:

- Çekirdeği güncel tutun (Ubuntu ve Debian'da `unattended-upgrades`) ve güncellemeden sonra yeniden başlatın;
  kullanıcı ad alanları üzerinden gelen açıkların çoğu çekirdek güncellemesiyle kapanır.
- Leaf Bot'u, güvenmediğiniz ya da çok önemli başka işlerle aynı sunucuda değil, kendi sanal sunucusunda
  çalıştırın.
- Ubuntu 23.10 ve sonrasında `kernel.apparmor_restrict_unprivileged_userns=1` ayarını açık bırakın:
  `leafbot-userns` profili yalnızca bu iki kapsayıcıya izin verir, ana makinedeki öteki programlar kısıtlı
  kalır. Kullanıcı ad alanlarını çekirdekte tümden kapatmak (`user.max_user_namespaces=0`) bu kapsayıcılardaki
  yalıtımı da durdurur.

Durumu Ayarlar → Bağlantı → "Bash yalıtımı" satırında görürsünüz; sunucu açılışta yalıtımı dener ve
çalışmazsa nedenini yazar.

### AppArmor

Docker'ın varsayılan AppArmor profili (`docker-default`) bağlama çağrılarını reddeder; AppArmor'lu bir
sunucuda "Bash yalıtımı" satırı "Çalışmıyor" gösterir ve Claude botları Bash çalıştıramaz. Ubuntu 23.10 ve
sonrası ayrıca kullanıcı ad alanlarını AppArmor ile kısıtlar (`kernel.apparmor_restrict_unprivileged_userns=1`);
bu kısıt profilsiz (`unconfined`) süreçlere de uygulanır, yani `apparmor=unconfined` yetmez.

`apparmor.sh` ana makineye bakıp `LEAFBOT_APPARMOR` değerini seçer; ana makinede root olarak bir kez
çalıştırın, yeniden çalıştırmak zarar vermez:

```bash
sudo ./docker/apparmor.sh --env docker/.env
docker compose -f docker/compose.yml --env-file docker/.env up -d
```

| Ana makine                                                            | Değer            | Betiğin yaptığı                     |
| --------------------------------------------------------------------- | ---------------- | ----------------------------------- |
| AppArmor kapalı                                                       | (yok)            | Hiçbir şey; satırı siler            |
| AppArmor açık, kullanıcı ad alanı kısıtı yok (ör. Debian 12)          | `unconfined`     | Değeri yazar                        |
| AppArmor kullanıcı ad alanlarını kısıtlıyor (Ubuntu 23.10 ve sonrası) | `leafbot-userns` | Profili kurar, yükler, değeri yazar |

`leafbot-userns`, `leafbot` ve `computer` kapsayıcılarına yalnızca kullanıcı ad alanı izni veren profildir
(`docker/apparmor/leafbot-userns`); `/etc/apparmor.d/` altına kurulur ve yeniden başlatmadan sonra da yüklü
kalır. Profil AppArmor 4 ister (Ubuntu 24.04); yüklü değilken bu değer verilirse kapsayıcı başlamaz.
Kullanıcı ad alanları çekirdekte kapalıysa betik bunu ve nasıl açılacağını söyler. `--env` verilmezse betik
değeri yalnızca yazdırır; `--remove` profili kaldırır.

Profil Ubuntu 24.04'te denendi. SELinux'un kapsayıcı politikası da bubblewrap'i engelleyebilir; SELinux'lu
bir sunucuda denenmedi.

#### Dokploy ve benzeri paneller

Panel her yayında depoyu yeniden indirir ve `docker/.env` dosyasını kendi ayarlarından yeniden yazar; bu
yüzden `--env` kullanmayın. Sunucuya SSH ile bağlanıp betiği panelin indirdiği kopyadan çalıştırın
(Dokploy'da `/etc/dokploy/compose/<uygulama>/code`):

```bash
sudo /etc/dokploy/compose/<uygulama>/code/docker/apparmor.sh
```

Betiğin yazdırdığı `LEAFBOT_APPARMOR=…` satırını panelde uygulamanın ortam değişkenlerine (Dokploy'da
Environment) ekleyip yeniden yayınlayın. Profil `/etc/apparmor.d/` altında durduğu için yeni yayınlar onu
silmez.

Alan adını `leafbot` servisine değil, `gateway` servisine bağlayın. Ortam değişkenlerine
`COMPOSE_PROFILES=gateway` ekleyin, Domains'te servis olarak `gateway`, port olarak `4319` seçin ve yeniden
yayınlayın. Panel, alan adının bağlı olduğu servisi kendi ağına (Dokploy'da `dokploy-network`) ve projenin
`default` ağına ekler. O ağ paneldeki bütün uygulamaları (panelin kendi veritabanı dahil) birbirine bağlar ve
internete kendi yolundan çıkar. Alan adı sunucuya bağlıyken sunucu kapsayıcısı bu ağlarda durur: internete
`egress` köprüsünden değil oradan çıkar, güvenlik duvarının dışında kalır ve öteki uygulamalara ulaşır.
`gateway` yalnızca isteği sunucuya ileten küçük bir Caddy'dir (`Caddyfile.gateway`); sunucuya yalnızca `edge`
ağından ulaşır ve panelin ağına giren yalnızca o olur. HTTPS'i panel sağlar; `Host`, `X-Forwarded-Proto` ve
`X-Forwarded-For` başlıkları sunucuya olduğu gibi geçer.

Daha önce alan adını `leafbot`'a bağladıysanız Domains'te servisi `gateway` yapıp yeniden yayınlayın; panel
eklediği ağları sunucudan o zaman kaldırır. Kontrol için sunucu kapsayıcısının ağlarında `dokploy-network`
görünmemelidir:

```bash
docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' <uygulama>-leafbot-1
```

Yayın `networks have same bridge name` hatasıyla durursa bu sunucuda `leafbot0` köprüsünü kullanan başka
bir ağ vardır: çoğunlukla aynı sunucudaki önceki bir kurulumdan ya da panelde silinip yeniden açılmış bir
uygulamadan kalmıştır. Panel her uygulamaya kendi proje adını verdiği için ağ adları farklıdır, ama köprü
adı güvenlik duvarı onu bulabilsin diye sabittir. Hangi ağın tuttuğunu görmek için:

```bash
docker network ls -q | xargs docker network inspect -f '{{.Name}} {{index .Options "com.docker.network.bridge.name"}} {{len .Containers}}' | grep leafbot0
```

Ağ eski bir kurulumdan kaldıysa ve kapsayıcısı yoksa (son sayı 0) `docker network rm <ad>` ile silip yeniden
yayınlayın. İki kurulumu aynı sunucuda birlikte çalıştırmak istiyorsanız ikincisine panelde
`LEAFBOT_BRIDGE=leafbot1` gibi başka bir ad verin (en çok 15 karakter). Öteki kurulum `127.0.0.1:4319`'u
tuttuğu için `LEAFBOT_PORT=4329` gibi başka bir port da verin. Bu yalnızca ana makinedeki portu değiştirir;
panelde alan adının hedef portu yine `4319` kalır, çünkü panel servise kapsayıcının kendi portundan bağlanır.

Panel güvenlik duvarını kurmaz. Yayından sonra her kurulum için, kendi köprüsüyle, bir kez:

```bash
sudo BRIDGE=leafbot0 /etc/dokploy/compose/<uygulama>/code/docker/firewall.sh
```

Kurallar köprüye göre eklenir; iki kurulumun kuralları birbirini silmez, başka kapsayıcıların trafiğine de
dokunmaz. Yeniden başlatmadan sonra da kalmaları için her kuruluma bir servis yazın; Docker yeniden
başladığında da çalışır, panel yeniden yayınlayınca köprü aynı adla geri geldiği için kurallar geçerli kalır:

```bash
sudo tee /etc/systemd/system/leafbot-firewall-<uygulama>.service <<'EOF'
[Unit]
Description=Leaf Bot egress firewall (<uygulama>)
After=docker.service
Requires=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=BRIDGE=leafbot0
ExecStart=/bin/sh /etc/dokploy/compose/<uygulama>/code/docker/firewall.sh --wait

[Install]
WantedBy=multi-user.target docker.service
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now leafbot-firewall-<uygulama>.service
```

Uygulamayı panelden silerseniz servisini de kaldırın (`systemctl disable --now …` ve dosyayı silin); yoksa
açılışta betiği bulamaz ve başarısız görünür.

Kurallar kapsayıcıların ana makineye yeni bağlantı açmasını da kapatır. Sunucuya verilen TURN sunucusu (coturn)
aynı makinede çalışıyorsa bu, sunucunun TURN'e ulaşmasını da engeller ve tarayıcılar sunucuya web'den
bağlanamaz. O zaman servise TURN'ün portlarını `HOST_PORTS` ile açın; ana makinenin kendi güvenlik duvarı
(`ufw`) yine geçerlidir, bu portlar zaten herkese açık olduğundan botlara yeni bir şey açılmaz:

```bash
sudo systemctl edit leafbot-firewall-<uygulama>.service
```

```ini
[Service]
Environment="HOST_PORTS=udp/3478 tcp/3478 udp/49152:65535"
```

```bash
sudo systemctl restart leafbot-firewall-<uygulama>.service
```

##### Hazır imajlarla

Panel her yayında `leafbot` ve `computer` imajlarını indirdiği daldan derler: bu 10-20 dakika sürer ve
sunucuya dalın en son commit'ini koyar. Otomatik yayın açıksa her push sunucuyu günceller. Sunucunun
yalnızca yayımlanmış sürümle çalışması ve siz yayınlayınca güncellenmesi için `docker/compose.images.yml`
eklenir. Bu dosya derlemeyi kaldırır, her yayında sürümün imajlarını yeniden indirir:

1. Dokploy'da uygulamanın Advanced sekmesindeki Run Command'da `-f ./docker/compose.yml`'nin hemen arkasına
   `-f ./docker/compose.images.yml` ekleyin. Komutun geri kalanı panelin gösterdiği gibi kalır, yalnız
   `compose` ile başlar: panel başına `docker` kendisi ekler. Ör.:

   ```text
   compose -p <uygulama> --env-file docker/.env -f ./docker/compose.yml -f ./docker/compose.images.yml up -d --build --remove-orphans
   ```

2. Otomatik yayını (Autodeploy) kapatın; push'lar artık sunucuya ulaşmaz.
3. Yeni bir sürüm yayımlandığında panelde Deploy'a basın.

`LEAFBOT_VERSION` boşken en son sürüm (`latest`) kullanılır; ortam değişkenlerine `LEAFBOT_VERSION=0.10.0`
gibi bir sürüm yazarak (başında `v` olmadan) o sürüme sabitlenir. Panel compose dosyalarını yine kendi
dalından alır; dal genelde sürümden yenidir, yani dosyalar sunucudan biraz ileride olabilir.

Sunucu daldan derlenmiş, en son sürümden yeni bir kodla çalışıyorsa bu dosyayı en az o kadar yeni bir sürüm
çıkana kadar eklemeyin. Yeni kod veritabanının yapısını ilerletmiştir; eski bir sürüm o veritabanıyla
çalışmayabilir. Geçmeden önce veritabanını yedekleyin.

## Botların bilgisayarı

Her botun kendi Linux masaüstü oturumu vardır: panel, tarayıcı, terminal, dosya yöneticisi, LibreOffice ve
metin düzenleyici. Oturumlar `computer` kapsayıcısında çalışır; sunucu ona HTTP ile ve WebSocket ile
bağlanır. Her oturum ayrı bir bubblewrap yalıtımındadır: kendi ekranı, kendi süreçleri ve kendi ana
klasörü vardır, yalnızca botun klasörlerini görür. Başka botların dosyalarını ve `computer` kapsayıcısının
ortam değişkenlerini (erişim belirteci dahil) görmez.

Kurulum için `.env` dosyasına `LEAFBOT_COMPUTER_TOKEN` yazın (en az 32 karakter; `openssl rand -hex 32`).
Sunucu ile `computer` kapsayıcısı bu değerle birbirini tanır; `computer` ağı yalnızca bu ikisini bağlar ve
dışarı çıkışı yoktur.

- **Docker Engine 26 ya da üstü gerekir.** `computer` kapsayıcısı `data` birimindeki yalnızca `workspaces`
  klasörünü bağlar (`volume.subpath`); eski sürümlerde bu seçenek tanınmaz. Klasörü sunucu ilk açılışta
  oluşturur; bu yüzden `computer` kapsayıcısı sunucu sağlıklı olduktan sonra başlar.
- **Kaynak kullanımı:** boştaki bir masaüstü yaklaşık 70–140 MB bellek tutar, açık bir tarayıcı yaklaşık 200 MB
  daha ekler. Kapsayıcı en çok 6 GB belleğe ve 3 işlemciye sınırlıdır; aynı anda en çok 3 masaüstü
  çalışır (`LEAFBOT_COMPUTER_MAX`). Sınır dolunca yeni masaüstü açılmaz.
- **Masaüstlerinin interneti açıktır.** Oturumlar kapsayıcının ağını paylaşır, yani `firewall.sh`
  kuralları onlar için de geçerlidir. Bir oturumun ekranına başka bir oturum bağlanamaz (her ekranın
  kendi X yetki çerezi vardır), ama ağ düzeyinde oturumlar birbirinden ayrı değildir.
- **Masaüstünü yalnızca interneti açık botlar kullanır.** Bot ayarlarında "İnternet erişimi" kapalı olan
  bota masaüstü verilmez; komutları sunucunun yalıtımında, internete çıkmadan çalışır. Masaüstündeki
  her komut yine botun izin ayarlarına göre sorulur.
- Oturumun içindeki tarayıcı Google Chrome'dur (Google'ın kendi paket deposundan). Kendi yalıtımı
  açıktır; bunun için `seccomp.json` ayrıca `chroot` çağrısına izin verir (Docker'ın varsayılanı bunu
  yalnızca `CAP_SYS_CHROOT` ile verir). Kapsayıcının `/proc` maskeleri `systempaths=unconfined` ile Bash
  yalıtımındaki gibi kaldırılır.
- Masaüstü oturumları kapsayıcı yeniden başlayınca kapanır; botların ana klasörleri ve dosyaları
  `data` biriminde kalır.
- **GitHub, git rölesi üzerinden.** Masaüstlerinde git, pnpm ve yarn (corepack) kuruludur. Oturumdaki git
  `github.com` adreslerini kapsayıcının `127.0.0.1:4322` adresindeki röleye gönderir
  (`LEAFBOT_COMPUTER_GIT_PORT`); röle, bota açık ve `https://github.com` için kaydedilmiş API anahtarını
  isteğe ekler. Anahtar oturuma hiç girmez. Röle yalnızca git isteklerini ve yalnızca GitHub'a geçirir;
  deponun varsayılan dalına push'u reddeder. Oturumlar ağı paylaştığı için her oturumun röle adresinde
  kendine ait rastgele bir anahtar vardır.
