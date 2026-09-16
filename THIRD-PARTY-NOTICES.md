# Componentes de terceiros — áudio

Os binários necessários já estão em `public/vendor/rnnoise`. Não é necessário
contratar um serviço de redução de ruído ou executar um build para publicá-los.

## @sapphi-red/web-noise-suppressor 0.4.0

- Origem: https://github.com/sapphi-red/web-noise-suppressor
- Pacote: https://registry.npmjs.org/@sapphi-red/web-noise-suppressor/-/web-noise-suppressor-0.4.0.tgz
- Integridade SHA-512 do pacote, conferida antes da extração:
  `vkBEL/VDkbeP3qqSRQFRtPLGa19a38JUzO6J0r5D/MQSumrlERy671DAMaETgY6etXjDCoJcD7JBIaXnuGVtVw==`
- Licença MIT: `public/vendor/rnnoise/LICENSE-MIT.txt`.
- Arquivos utilizados: `dist/rnnoise/workletProcessor.js` e `dist/rnnoise.wasm`.

O processador foi renomeado para `worklet.js` e recebeu ajustes locais de
inicialização e descarte: inicia a porta de mensagens, informa quando o WASM
está pronto, comunica falhas de inicialização e encerra o processamento após
`destroy`. A referência ao source map não distribuído foi removida.
O arquivo WASM não foi alterado; foi escolhida a variante sem SIMD.

## Shiguredo RNNoise WASM 2022.2.0

O processador acima incorpora código de https://github.com/shiguredo/rnnoise-wasm.
Licença Apache 2.0 em `public/vendor/rnnoise/LICENSE-APACHE.txt`, obtida de:
https://raw.githubusercontent.com/shiguredo/rnnoise-wasm/2022.2.0/LICENSE

## RNNoise / Xiph.Org

Biblioteca de redução de ruído: https://github.com/xiph/rnnoise.
Avisos e licença BSD em `public/vendor/rnnoise/LICENSE-RNNOISE.txt`, obtidos de:
https://raw.githubusercontent.com/xiph/rnnoise/main/COPYING

Preserve estes avisos e as licenças ao redistribuir os arquivos.

## Helpers incorporados no processador

- Babel: helpers de conversão e propriedades, MIT.
  https://github.com/babel/babel — `public/vendor/rnnoise/LICENSE-BABEL.txt`.
- wasm-feature-detect: detecção de SIMD, Apache 2.0.
  https://github.com/GoogleChromeLabs/wasm-feature-detect —
  `public/vendor/rnnoise/LICENSE-WASM-FEATURE-DETECT.txt`.
