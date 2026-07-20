# Radar Energia

## Objetivo

O Radar Energia é um MVP web estático para localizar imóveis e estabelecimentos públicos próximos a um CEP e estimar um potencial de alto consumo energético a partir de informações públicas. O aplicativo nunca consulta contas reais, consumo individual ou dados privados.

## Tecnologias

- HTML5
- CSS3
- JavaScript puro
- Leaflet
- OpenStreetMap
- ViaCEP
- Nominatim
- Overpass API
- localStorage

## Como executar localmente

1. Acesse a pasta do projeto.
2. Inicie um servidor estático:

```bash
python -m http.server 8080
```

3. Abra o endereço:

```text
http://localhost:8080
```

## Como testar

- Informe um CEP válido de Recife, como `50010-010`.
- Escolha o raio.
- Clique em "Buscar oportunidades".
- Verifique se o mapa centraliza no ponto e exibe marcadores coloridos.
- Salve uma oportunidade e atualize a página para confirmar que o item permanece em `localStorage`.

## Publicação no GitHub Pages

1. Crie um repositório no GitHub.
2. Envie os arquivos para o branch principal.
3. Ative o GitHub Pages na pasta raiz do site.
4. Use o nome do domínio padrão fornecido pelo GitHub Pages.

## Limitações

- O sistema usa apenas informações públicas do OpenStreetMap.
- A classificação é uma estimativa e não confirma consumo real nem conta de energia.
- A consulta depende da disponibilidade dos serviços públicos de geocodificação e do Overpass API.
- O mapa e os marcadores podem ser limitados por rede, paginador ou rate limiting dos serviços.

## Aviso sobre estimativas e privacidade

> Este aplicativo utiliza somente informações públicas e gera estimativas de potencial energético. O valor real da conta, o consumo individual e a identidade dos moradores não são consultados.
