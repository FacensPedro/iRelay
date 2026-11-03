# iRelay

Programa para Windows que baixa jogos da Steam no PC e envia ao [iDeck](https://github.com/FacensPedro/iDeck) **enquanto baixa**.

## Como funciona

1. Instale no PC o app **Apple Devices** (Microsoft Store) ou o iTunes — o iRelay usa o serviço de dispositivos da Apple para falar com o iPad pelo cabo.
2. Conecte o iPad ao PC com o cabo USB e toque em **Confiar** no iPad.
3. Abra o iRelay no PC. A janela mostra o estado do cabo e um código de pareamento.
4. No iDeck: **Ajustes › Steam › iRelay** — ative, escolha **Conexão: Cabo USB**, digite o código e toque em **Testar conexão**.
3. Instale um jogo da Steam no iDeck normalmente. O iDeck envia ao iRelay a lista de pedaços que ainda faltam; o PC começa a baixar todos na velocidade dele e o iDeck pega cada pedaço do PC assim que chega.

- O iRelay não precisa da sua conta Steam: ele baixa dos mesmos servidores de conteúdo que o iDeck usa, com a autorização que o iDeck envia. Os pedaços ficam criptografados no PC; quem confere e descriptografa é o iDeck.
- Se o PC parar de responder, o iDeck continua baixando da Steam sozinho.
- Por padrão cada pedaço é apagado do PC depois de enviado ao iDeck.

### Cabo USB

O iOS não deixa apps abrirem rede pelo cabo, então a conexão é ao contrário: o iRelay abre, pelo usbmux da Apple (127.0.0.1:27015), algumas conexões até a porta 27091 do iPad; o iDeck usa cada uma para um pedido e o iRelay liga a outra ponta ao seu servidor. Wi‑Fi continua disponível como opção (digite o endereço mostrado na janela).

## Botão "Ignorar Windows Defender"

Pede permissão de administrador e:
- adiciona a pasta do iRelay e a pasta do cache às exclusões do Microsoft Defender Antivírus (os pedaços não são verificados a cada gravação);
- libera o iRelay no Firewall do Windows Defender, só na rede local (porta TCP 27090), para o iDeck conseguir se conectar.

**Desfazer** remove as exclusões e a regra do firewall.

## Download

Baixe o `iRelay.exe` em [Releases](../../releases) ou nos artefatos do workflow **Build**. Não precisa instalar o .NET.

## Compilar

```
dotnet publish src/iRelay/iRelay.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
```

## Protocolo (porta 27090, cabeçalho `X-iRelay-Code` em todo pedido)

| Pedido | Resposta |
|---|---|
| `GET /ping` | `{"name":"iRelay","version":1,"machine":"..."}` |
| `POST /jobs` | `{"appId","name","depots":[{"depotId","hosts":[...],"auth":{host:"?token=..."},"chunks":["sha1hex",...]}]}` inicia o download |
| `GET /depot/<id>/chunk/<sha1>` | o pedaço como o servidor de conteúdo envia (cache, aguarda ou baixa na hora) |
