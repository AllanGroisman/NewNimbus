<?php
// Metadados desta pagina. Todo o resto do <head><meta charset="utf-8"> vem de header.php
$pageTitle       = 'Nimbus — Ofertas no automático nos seus grupos de WhatsApp';
$pageDescription = 'A Nimbus seleciona as ofertas, monta a mensagem com a imagem e o seu link e publica nos seus grupos de WhatsApp nos horários que você definir. Teste 7 dias por R$ 1,00.';
$pageCanonical   = 'https://nimbuspromocoes.com/software/';
$pageOgTitle       = 'Seus grupos entregando ofertas o dia inteiro. Sem você postar nada.';
$pageOgDescription = 'A Nimbus seleciona as ofertas, monta a mensagem e publica nos seus grupos de WhatsApp. Teste 7 dias por R$ 1,00.';
include __DIR__ . '/header.php';
?>

    <style>
        :root {
            --color-bg: #ffffff;
            --color-bg-soft: #fafaf9;
            --color-bg-muted: #f5f5f4;
            --color-border: #e7e5e4;
            --color-ink: #0a0a0a;
            --color-ink-soft: #404040;
            --color-ink-muted: #737373;
            --color-brand: #ff6a00;
            --color-brand-dark: #e85d00;
            --color-brand-soft: #fff4eb;
            --color-dark: #0a0a0a;
        }

        html { scroll-behavior: smooth; }
        body {
            font-family: 'Inter', sans-serif;
            color: var(--color-ink);
            background: var(--color-bg);
            font-feature-settings: "ss01", "cv11";
            -webkit-font-smoothing: antialiased;
            margin: 0;
            padding: 40px 0 0;
            overflow-x: hidden;
        }
        .font-display { font-family: 'Sora', sans-serif; letter-spacing: -0.02em; }
        [x-cloak] { display: none !important; }

        /* Hero dark com grid sutil */
        .hero-dark {
            background: var(--color-dark);
            background-image:
                radial-gradient(circle at 20% 30%, rgba(255, 106, 0, 0.12) 0%, transparent 50%),
                radial-gradient(circle at 80% 70%, rgba(255, 106, 0, 0.06) 0%, transparent 40%);
        }
        .hero-grid::before {
            content: "";
            position: absolute;
            inset: 0;
            background-image:
                linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px);
            background-size: 64px 64px;
            mask-image: radial-gradient(ellipse at center, black 30%, transparent 75%);
            -webkit-mask-image: radial-gradient(ellipse at center, black 30%, transparent 75%);
            pointer-events: none;
        }

        /* Animações */
        @keyframes fadeUp {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .anim-fadeup { animation: fadeUp 0.8s ease-out both; }
        .delay-100 { animation-delay: 0.1s; }
        .delay-200 { animation-delay: 0.2s; }
        .delay-300 { animation-delay: 0.3s; }
        .delay-400 { animation-delay: 0.4s; }

        /* Botão primário */
        .btn-primary {
            background: var(--color-brand);
            color: white;
            transition: all 0.2s ease;
            box-shadow: 0 1px 2px rgba(0,0,0,0.05), 0 0 0 0 rgba(255,106,0,0.4);
        }
        .btn-primary:hover {
            background: var(--color-brand-dark);
            transform: translateY(-1px);
            box-shadow: 0 8px 24px -8px rgba(255,106,0,0.5);
        }
        .btn-secondary {
            background: transparent;
            color: white;
            border: 1px solid rgba(255,255,255,0.15);
            transition: all 0.2s ease;
        }
        .btn-secondary:hover {
            background: rgba(255,255,255,0.05);
            border-color: rgba(255,255,255,0.3);
        }

        /* Cards com hover refinado */
        .card-soft {
            background: white;
            border: 1px solid var(--color-border);
            transition: all 0.3s ease;
        }
        .card-soft:hover {
            border-color: var(--color-ink);
            transform: translateY(-2px);
        }

        /* Icon containers */
        .icon-wrap {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 44px;
            height: 44px;
            border-radius: 12px;
            background: var(--color-brand-soft);
            color: var(--color-brand);
        }
        .icon-wrap-dark {
            background: rgba(255, 106, 0, 0.12);
            color: var(--color-brand);
        }

        /* Plano destacado */
        .plan-highlight {
            background: linear-gradient(180deg, #0a0a0a 0%, #1a1a1a 100%);
            color: white;
        }
        .plan-highlight .plan-price { color: var(--color-brand); }

        /* Marquee de marketplaces */
        .marketplace-row {
            display: flex;
            gap: 3rem;
            align-items: center;
            opacity: 0.5;
            transition: opacity 0.3s;
        }
        .marketplace-row:hover { opacity: 0.9; }

        /* FAQ */
        .faq-item summary { list-style: none; cursor: pointer; }
        .faq-item summary::-webkit-details-marker { display: none; }
        .faq-item[open] .faq-chevron { transform: rotate(180deg); }
        .faq-chevron { transition: transform 0.3s ease; }

        /* Linha divisória sutil */
        .divider-soft {
            border-image: linear-gradient(90deg, transparent, var(--color-border), transparent) 1;
        }

        /* Lucide icon sizing default */
        [data-lucide] { width: 20px; height: 20px; stroke-width: 1.5; }

        /* ========== BARRA DE OFERTA ========== */
        .topbar {
            position: fixed;
            top: 0; left: 0; right: 0;
            z-index: 60;
            display: block;
            padding: 0.65rem 1rem;
            background: var(--color-brand);
            color: #fff;
            text-align: center;
            font-size: 0.8125rem;
            font-weight: 600;
            letter-spacing: 0.01em;
            text-decoration: none;
            transition: background 0.2s ease;
        }
        .topbar:hover { background: var(--color-brand-dark); }

        /* ========== MODO REPASSE ========== */
        .repasse-dark {
            background: #050505;
            background-image: radial-gradient(circle at 70% 40%, rgba(255,106,0,0.10) 0%, transparent 55%);
            border-top: 1px solid rgba(255,255,255,0.06);
        }
        .repasse-tag {
            display: inline-block;
            padding: 0.4rem 0.9rem;
            border-radius: 999px;
            background: var(--color-brand);
            color: #fff;
            font-size: 0.7rem;
            font-weight: 700;
            letter-spacing: 0.16em;
            text-transform: uppercase;
        }
        .rp-node-title {
            fill: #fff;
            font-family: 'Sora', sans-serif;
            font-size: 17px;
            font-weight: 600;
        }
        .rp-node-sm {
            fill: #fff;
            font-family: 'Sora', sans-serif;
            font-size: 12px;
            font-weight: 600;
        }
        .rp-node-sub {
            fill: rgba(255,255,255,0.45);
            font-family: 'Inter', sans-serif;
            font-size: 12px;
        }
        .rp-caption-gray {
            fill: #6b7280;
            font-family: 'Inter', sans-serif;
            font-size: 13px;
            font-weight: 500;
        }
        .rp-caption-orange {
            fill: var(--color-brand);
            font-family: 'Inter', sans-serif;
            font-size: 13px;
            font-weight: 600;
        }

        /* ========== QUADRO SEM / COM ========== */
        .compare-col { border-radius: 24px; padding: 2rem 1.75rem; }
        .compare-without { background: var(--color-bg-muted); border: 1px solid var(--color-border); }
        .compare-with { background: var(--color-brand); }
        .compare-head {
            font-size: 0.7rem;
            font-weight: 700;
            letter-spacing: 0.18em;
            text-transform: uppercase;
            margin-bottom: 0.5rem;
        }
        .compare-without .compare-head { color: #78716c; }
        .compare-with .compare-head { color: rgba(255,255,255,0.75); }
        .compare-item {
            padding: 1rem 0;
            line-height: 1.55;
            display: flex;
            gap: 0.75rem;
            align-items: flex-start;
        }
        .compare-mark {
            flex-shrink: 0;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 22px; height: 22px;
            border-radius: 999px;
            margin-top: 0.1rem;
        }
        .compare-mark [data-lucide] { width: 14px; height: 14px; stroke-width: 2.5; }
        .compare-mark-x {
            background: rgba(120,113,108,0.15);
            color: #78716c;
        }
        .compare-mark-check {
            background: #fff;
            color: var(--color-brand);
        }
        .compare-without .compare-item { border-top: 1px solid var(--color-border); color: #57534e; }
        .compare-with .compare-item { border-top: 1px solid rgba(255,255,255,0.22); color: #fff; }

        /* ========== PASSOS ========== */
        .step-num {
            font-family: 'Sora', sans-serif;
            font-size: 2.25rem;
            font-weight: 800;
            line-height: 1;
            color: var(--color-brand);
            flex-shrink: 0;
            width: 3.25rem;
        }

        /* ========== SELOS DO TESTE ========== */
        .test-badge {
            display: inline-flex;
            align-items: center;
            gap: 0.65rem;
            color: rgba(255,255,255,0.85);
            font-weight: 500;
        }
        .test-badge-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 26px; height: 26px;
            border-radius: 999px;
            background: #25D366;
            color: #fff;
        }
        .test-badge-icon [data-lucide] { width: 15px; height: 15px; stroke-width: 3; }

        /* ========== MOVIMENTOS DO REPASSE ========== */
        .rp-step-num {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 32px; height: 32px;
            border-radius: 8px;
            font-family: 'Sora', sans-serif;
            font-size: 0.95rem;
            font-weight: 700;
            color: var(--color-brand);
            background: rgba(255,106,0,0.12);
            border: 1px solid rgba(255,106,0,0.3);
        }

        /* ========== BOTÃO WHATSAPP ========== */
        .btn-whatsapp {
            background: #25D366;
            color: #fff;
            transition: all 0.2s ease;
            box-shadow: 0 1px 2px rgba(0,0,0,0.05);
        }
        .btn-whatsapp:hover {
            background: #1eb355;
            transform: translateY(-1px);
            box-shadow: 0 8px 24px -8px rgba(37,211,102,0.5);
        }

        /* ========== ACESSIBILIDADE ========== */
        a:focus-visible, button:focus-visible, summary:focus-visible {
            outline: 2px solid var(--color-brand);
            outline-offset: 3px;
        }
        @media (prefers-reduced-motion: reduce) {
            .anim-fadeup { animation: none; }
            html { scroll-behavior: auto; }
        }
    </style>
</head>
<body>

    <!-- ============== BARRA DE OFERTA ============== -->
    <a href="#teste" class="topbar">Teste 7 dias por R$ 1,00</a>
    <!-- ============== HERO ============== -->
    <header class="hero-dark hero-grid relative overflow-hidden">
        <div class="relative mx-auto max-w-7xl px-6 py-20 md:py-28 lg:py-32">
            <div class="grid grid-cols-1 items-center gap-12 lg:grid-cols-12 lg:gap-8">

                <!-- Texto -->
                <div class="lg:col-span-7 text-center lg:text-left">
                    <div class="anim-fadeup inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 backdrop-blur-sm px-4 py-1.5 mb-8">
                        <span class="relative flex h-2 w-2">
                            <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-500 opacity-75"></span>
                            <span class="relative inline-flex h-2 w-2 rounded-full" style="background:var(--color-brand)"></span>
                        </span>
                        <span class="text-xs font-medium tracking-wide text-white/80 uppercase">Operação em escala</span>
                    </div>

                    <h1 class="anim-fadeup delay-100 font-display text-4xl font-extrabold leading-[1.05] text-white md:text-6xl xl:text-7xl mb-6">
                        Seus grupos entregando<br>
                        ofertas o dia inteiro.<br>
                        <span style="color:var(--color-brand)">Sem você postar nada.</span>
                    </h1>

                    <p class="anim-fadeup delay-200 mb-10 text-lg leading-relaxed text-white/60 md:text-xl max-w-xl mx-auto lg:mx-0">
                        A Nimbus seleciona as ofertas, monta a mensagem com a imagem e o seu link e publica nos horários que você definir. Você configura uma vez.
                    </p>

                    <div class="anim-fadeup delay-300 flex flex-col sm:flex-row gap-3 justify-center lg:justify-start">
                        <a href="#teste" class="btn-primary inline-flex items-center justify-center gap-2 rounded-2xl px-7 py-4 text-base font-semibold">
                            <span>Quero escalar minhas vendas</span>
                            <i data-lucide="arrow-right"></i>
                        </a>
                        <a href="#como-funciona" class="btn-secondary inline-flex items-center justify-center gap-2 rounded-2xl px-7 py-4 text-base font-semibold">
                            <i data-lucide="play-circle"></i>
                            <span>Como funciona</span>
                        </a>
                    </div>

                    <div class="anim-fadeup delay-400 mt-8 flex flex-wrap items-center justify-center lg:justify-start gap-3 text-sm">
                        <span class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border text-white/70" style="border-color:rgba(37,211,102,0.25); background:rgba(37,211,102,0.05)">
                            <i data-lucide="badge-check" style="width:16px;height:16px;color:#25D366;stroke-width:2"></i>
                            Sem fidelidade
                        </span>
                        <span class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border text-white/70" style="border-color:rgba(37,211,102,0.25); background:rgba(37,211,102,0.05)">
                            <i data-lucide="badge-check" style="width:16px;height:16px;color:#25D366;stroke-width:2"></i>
                            Teste 7 dias por R$ 1
                        </span>
                        <span class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border text-white/70" style="border-color:rgba(37,211,102,0.25); background:rgba(37,211,102,0.05)">
                            <i data-lucide="badge-check" style="width:16px;height:16px;color:#25D366;stroke-width:2"></i>
                            Setup em minutos
                        </span>
                    </div>
                </div>
                <!-- Diagrama do Fluxo Nimbus -->
                <div class="lg:col-span-5 anim-fadeup delay-200 relative">
                    <div class="relative">
                        <!-- Glow de fundo -->
                        <div class="absolute -inset-8 rounded-full opacity-40 blur-3xl" style="background:radial-gradient(circle, var(--color-brand) 0%, transparent 60%)"></div>

                        <!-- SVG do diagrama -->
                        <svg viewBox="0 0 600 540" xmlns="http://www.w3.org/2000/svg" class="relative w-full max-w-[560px] mx-auto" preserveAspectRatio="xMidYMid meet">
                            <defs>
                                <!-- Gradiente do quadrado central (Nimbus) -->
                                <linearGradient id="nimbusGrad" x1="0" y1="0" x2="1" y2="1">
                                    <stop offset="0%" stop-color="#ff8c2a"/>
                                    <stop offset="100%" stop-color="#ff6a00"/>
                                </linearGradient>
                                <!-- Glow laranja -->
                                <radialGradient id="orangeGlow" cx="0.5" cy="0.5" r="0.5">
                                    <stop offset="0%" stop-color="#ff6a00" stop-opacity="0.4"/>
                                    <stop offset="100%" stop-color="#ff6a00" stop-opacity="0"/>
                                </radialGradient>
                                <!-- Glow verde -->
                                <radialGradient id="greenGlowGrad" cx="0.5" cy="0.5" r="0.5">
                                    <stop offset="0%" stop-color="#25D366" stop-opacity="0.35"/>
                                    <stop offset="100%" stop-color="#25D366" stop-opacity="0"/>
                                </radialGradient>
                                <!-- Sombra dos cards -->
                                <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="140%">
                                    <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#000" flood-opacity="0.4"/>
                                </filter>
                                <!-- Glow das partículas -->
                                <filter id="particleGlow" x="-100%" y="-100%" width="300%" height="300%">
                                    <feGaussianBlur stdDeviation="2" result="blur"/>
                                    <feMerge>
                                        <feMergeNode in="blur"/>
                                        <feMergeNode in="SourceGraphic"/>
                                    </feMerge>
                                </filter>
                                <!-- Glow verde suave para grupos WhatsApp -->
                                <filter id="greenGlow" x="-50%" y="-50%" width="200%" height="200%">
                                    <feGaussianBlur stdDeviation="6" result="blur"/>
                                    <feFlood flood-color="#25D366" flood-opacity="0.35"/>
                                    <feComposite in2="blur" operator="in" result="glow"/>
                                    <feMerge>
                                        <feMergeNode in="glow"/>
                                        <feMergeNode in="SourceGraphic"/>
                                    </feMerge>
                                </filter>
                                <!-- Seta laranja (marketplace → nimbus) -->
                                <marker id="arrowOrange" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#ff6a00"/>
                                </marker>
                                <!-- Seta verde (nimbus → whatsapp) -->
                                <marker id="arrowGreen" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#25D366"/>
                                </marker>
                            </defs>

                            <!-- ===== GLOWS DE FUNDO ===== -->
                            <circle cx="300" cy="270" r="180" fill="url(#orangeGlow)"/>

                            <!-- ===== CONEXÕES ESQUERDA -> CENTRO (laranja) ===== -->
                            <!-- Card 1 (Shopee) -> Nimbus -->
                            <path id="pathShopee" d="M 180 180 C 212 180, 222 244, 240 262" fill="none" stroke="#ff6a00" stroke-width="1.5" stroke-opacity="0.6" marker-end="url(#arrowOrange)"/>
                            <!-- Card 2 (Mercado Livre) -> Nimbus -->
                            <path id="pathML" d="M 180 360 C 212 360, 222 296, 240 278" fill="none" stroke="#ff6a00" stroke-width="1.5" stroke-opacity="0.6" marker-end="url(#arrowOrange)"/>

                            <!-- Partículas animadas: Shopee -> Nimbus -->
                            <circle r="3.5" fill="#ff6a00" filter="url(#particleGlow)">
                                <animateMotion dur="2.5s" repeatCount="indefinite" rotate="auto">
                                    <mpath href="#pathShopee"/>
                                </animateMotion>
                                <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="2.5s" repeatCount="indefinite"/>
                            </circle>

                            <!-- Partículas animadas: Mercado Livre -> Nimbus -->
                            <circle r="3.5" fill="#ff6a00" filter="url(#particleGlow)">
                                <animateMotion dur="2.5s" begin="1.25s" repeatCount="indefinite" rotate="auto">
                                    <mpath href="#pathML"/>
                                </animateMotion>
                                <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="2.5s" begin="1.25s" repeatCount="indefinite"/>
                            </circle>

                            <!-- ===== CONEXÕES CENTRO -> DIREITA (verde) ===== -->
                            <!-- Nimbus -> Grupo 01 -->
                            <path id="pathG1" d="M 360 270 C 390 270, 400 90, 420 90" fill="none" stroke="#25D366" stroke-width="1.5" stroke-opacity="0.6" marker-end="url(#arrowGreen)"/>
                            <!-- Nimbus -> Grupo 02 -->
                            <path id="pathG2" d="M 360 270 L 420 270" fill="none" stroke="#25D366" stroke-width="1.5" stroke-opacity="0.6" marker-end="url(#arrowGreen)"/>
                            <!-- Nimbus -> Grupo 03 -->
                            <path id="pathG3" d="M 360 270 C 390 270, 400 450, 420 450" fill="none" stroke="#25D366" stroke-width="1.5" stroke-opacity="0.6" marker-end="url(#arrowGreen)"/>

                            <!-- Partículas verdes -->
                            <circle r="3.5" fill="#25D366" filter="url(#particleGlow)">
                                <animateMotion dur="2.5s" begin="0.6s" repeatCount="indefinite" rotate="auto">
                                    <mpath href="#pathG1"/>
                                </animateMotion>
                                <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="2.5s" begin="0.6s" repeatCount="indefinite"/>
                            </circle>
                            <circle r="3.5" fill="#25D366" filter="url(#particleGlow)">
                                <animateMotion dur="2.5s" begin="1.1s" repeatCount="indefinite" rotate="auto">
                                    <mpath href="#pathG2"/>
                                </animateMotion>
                                <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="2.5s" begin="1.1s" repeatCount="indefinite"/>
                            </circle>
                            <circle r="3.5" fill="#25D366" filter="url(#particleGlow)">
                                <animateMotion dur="2.5s" begin="1.6s" repeatCount="indefinite" rotate="auto">
                                    <mpath href="#pathG3"/>
                                </animateMotion>
                                <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="2.5s" begin="1.6s" repeatCount="indefinite"/>
                            </circle>

                            <!-- ============================================ -->
                            <!-- ===== CARDS ESQUERDA: MARKETPLACES ======== -->
                            <!-- ============================================ -->

                            <!-- SHOPEE -->
                            <g filter="url(#cardShadow)">
                                <rect x="20" y="130" width="160" height="100" rx="16" fill="#0d0d0d" stroke="#ff6a00" stroke-width="1.5"/>
                                <image href="/imagens/shopee.png?v=2" x="40" y="145" width="120" height="70" preserveAspectRatio="xMidYMid meet"/>
                            </g>

                            <!-- MERCADO LIVRE -->
                            <g filter="url(#cardShadow)">
                                <rect x="20" y="310" width="160" height="100" rx="16" fill="#0d0d0d" stroke="#ff6a00" stroke-width="1.5"/>
                                <image href="/imagens/mercadolivre.png?v=2" x="40" y="325" width="120" height="70" preserveAspectRatio="xMidYMid meet"/>
                            </g>
                            <!-- ============================================ -->
                            <!-- ===== QUADRADO CENTRAL: NIMBUS ============ -->
                            <!-- ============================================ -->
                            <!-- Halo externo -->
                            <rect x="232" y="202" width="136" height="136" rx="26" fill="none" stroke="#ff6a00" stroke-width="1" stroke-opacity="0.3"/>
                            <rect x="222" y="192" width="156" height="156" rx="30" fill="none" stroke="#ff6a00" stroke-width="1" stroke-opacity="0.15"/>

                            <!-- Quadrado principal -->
                            <g filter="url(#cardShadow)">
                                <rect x="240" y="210" width="120" height="120" rx="22" fill="#0d0d0d" stroke="#ff6a00" stroke-width="2"/>
                                <image href="/imagens/nimbus.png" x="255" y="225" width="90" height="90"/>
                            </g>

                            <!-- Pontos de conexão no Nimbus -->
                            <circle cx="240" cy="270" r="4" fill="#ff6a00" stroke="#0a0a0a" stroke-width="2"/>
                            <circle cx="360" cy="270" r="4" fill="#25D366" stroke="#0a0a0a" stroke-width="2"/>

                            <!-- ============================================ -->
                            <!-- ===== CARDS DIREITA: GRUPOS WHATSAPP ====== -->
                            <!-- ============================================ -->

                            <!-- GRUPO 01 -->
                            <g filter="url(#cardShadow)">
                                <rect x="420" y="40" width="160" height="100" rx="16" fill="#0d0d0d" stroke="#25D366" stroke-width="1.5"/>
                                <image href="/imagens/grupo1.png" x="440" y="55" width="120" height="70" preserveAspectRatio="xMidYMid meet"/>
                            </g>

                            <!-- GRUPO 02 -->
                            <g filter="url(#cardShadow)">
                                <rect x="420" y="220" width="160" height="100" rx="16" fill="#0d0d0d" stroke="#25D366" stroke-width="1.5"/>
                                <image href="/imagens/grupo2.png" x="440" y="235" width="120" height="70" preserveAspectRatio="xMidYMid meet"/>
                            </g>

                            <!-- GRUPO 03 -->
                            <g filter="url(#cardShadow)">
                                <rect x="420" y="400" width="160" height="100" rx="16" fill="#0d0d0d" stroke="#25D366" stroke-width="1.5"/>
                                <image href="/imagens/grupo3.png" x="440" y="415" width="120" height="70" preserveAspectRatio="xMidYMid meet"/>
                            </g>
                        </svg>
                    </div>
                </div>
            </div>
        </div>

    </header>

    <!-- ============== MODO REPASSE ============== -->
    <section id="modo-repasse" class="repasse-dark relative overflow-hidden px-6 py-16 md:py-24">
        <div class="mx-auto max-w-6xl relative">

            <div class="max-w-3xl">
                <span class="repasse-tag">Só na Nimbus &middot; Modo Repasse</span>
                <h2 class="font-display text-3xl md:text-5xl font-bold leading-[1.1] text-white mt-6 mb-8">
                    Toda oferta boa que você lê num grupo já virou comissão.<br>
                    <span style="color:var(--color-brand)">De outra pessoa.</span>
                </h2>
                <div class="space-y-5 text-lg leading-relaxed text-white/60 max-w-2xl">
                    <p>Você acompanha grupos de oferta o dia inteiro. Cada link que passa ali põe a comissão no bolso de outro afiliado.</p>
                    <p>Você pode copiar oferta por oferta e colar nos seus grupos, na mão, gastando o seu dia nisso. Ou pode apontar a fonte uma vez e deixar o Modo Repasse rodar sozinho.</p>
                    <p class="text-white font-semibold text-xl">A oferta é a mesma. A comissão passa a ser sua.</p>
                </div>
            </div>

            <!-- ===== DIAGRAMA: DESKTOP ===== -->
            <div class="mt-16 hidden md:block">
                <svg viewBox="0 0 900 300" xmlns="http://www.w3.org/2000/svg" class="w-full" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Fluxo do Modo Repasse: grupo de ofertas, Nimbus troca o link, seus grupos">
                    <defs>
                        <filter id="rpShadow" x="-20%" y="-20%" width="140%" height="140%">
                            <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#000" flood-opacity="0.45"/>
                        </filter>
                        <filter id="rpGlow" x="-100%" y="-100%" width="300%" height="300%">
                            <feGaussianBlur stdDeviation="2.5" result="b"/>
                            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
                        </filter>
                        <radialGradient id="rpHalo" cx="0.5" cy="0.5" r="0.5">
                            <stop offset="0%" stop-color="#ff6a00" stop-opacity="0.35"/>
                            <stop offset="100%" stop-color="#ff6a00" stop-opacity="0"/>
                        </radialGradient>
                        <symbol id="waIcon" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></symbol>
                        <marker id="rpArrowGray" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                            <path d="M 0 0 L 10 5 L 0 10 z" fill="#6b7280"/>
                        </marker>
                        <marker id="rpArrowOrange" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                            <path d="M 0 0 L 10 5 L 0 10 z" fill="#ff6a00"/>
                        </marker>
                    </defs>

                    <circle cx="450" cy="150" r="150" fill="url(#rpHalo)"/>

                    <!-- ENTRADA (cinza) -->
                    <path id="rpIn" d="M 250 150 L 385 150" fill="none" stroke="#6b7280" stroke-width="1.5" stroke-opacity="0.55" marker-end="url(#rpArrowGray)"/>

                    <!-- SAÍDAS (laranja) -->
                    <path id="rpOut1" d="M 515 150 C 560 150, 580 70, 640 70" fill="none" stroke="#ff6a00" stroke-width="1.5" stroke-opacity="0.6" marker-end="url(#rpArrowOrange)"/>
                    <path id="rpOut2" d="M 515 150 L 640 150" fill="none" stroke="#ff6a00" stroke-width="1.5" stroke-opacity="0.6" marker-end="url(#rpArrowOrange)"/>
                    <path id="rpOut3" d="M 515 150 C 560 150, 580 230, 640 230" fill="none" stroke="#ff6a00" stroke-width="1.5" stroke-opacity="0.6" marker-end="url(#rpArrowOrange)"/>

                    <!-- Partícula cinza entrando -->
                    <circle r="4" fill="#6b7280">
                        <animateMotion dur="3s" repeatCount="indefinite"><mpath href="#rpIn"/></animateMotion>
                        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.2;0.85;1" dur="3s" repeatCount="indefinite"/>
                    </circle>

                    <!-- Partículas laranja saindo -->
                    <circle r="4" fill="#ff6a00" filter="url(#rpGlow)">
                        <animateMotion dur="3s" begin="1.4s" repeatCount="indefinite"><mpath href="#rpOut1"/></animateMotion>
                        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="3s" begin="1.4s" repeatCount="indefinite"/>
                    </circle>
                    <circle r="4" fill="#ff6a00" filter="url(#rpGlow)">
                        <animateMotion dur="3s" begin="1.5s" repeatCount="indefinite"><mpath href="#rpOut2"/></animateMotion>
                        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="3s" begin="1.5s" repeatCount="indefinite"/>
                    </circle>
                    <circle r="4" fill="#ff6a00" filter="url(#rpGlow)">
                        <animateMotion dur="3s" begin="1.6s" repeatCount="indefinite"><mpath href="#rpOut3"/></animateMotion>
                        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="3s" begin="1.6s" repeatCount="indefinite"/>
                    </circle>

                    <!-- NÓ FONTE (cinza) -->
                    <g filter="url(#rpShadow)">
                        <rect x="30" y="105" width="220" height="90" rx="18" fill="#141414" stroke="#4b5563" stroke-width="1.5"/>
                        <use href="#waIcon" x="52" y="132" width="26" height="26" fill="#6b7280"/>
                        <text x="92" y="146" text-anchor="start" class="rp-node-title">Grupo de ofertas</text>
                        <text x="92" y="168" text-anchor="start" class="rp-node-sub">fonte que você acompanha</text>
                    </g>
                    <text x="140" y="222" text-anchor="middle" class="rp-caption-gray">comissão de outro afiliado</text>

                    <!-- NÓ NIMBUS -->
                    <rect x="378" y="88" width="144" height="124" rx="26" fill="none" stroke="#ff6a00" stroke-width="1" stroke-opacity="0.25"/>
                    <g filter="url(#rpShadow)">
                        <rect x="388" y="98" width="124" height="104" rx="22" fill="#0d0d0d" stroke="#ff6a00" stroke-width="2"/>
                        <image href="/imagens/nimbus.png" x="405" y="110" width="90" height="80" preserveAspectRatio="xMidYMid meet"/>
                    </g>
                    <text x="450" y="240" text-anchor="middle" class="rp-caption-orange">link trocado</text>

                    <!-- NÓS SEUS GRUPOS -->
                    <g filter="url(#rpShadow)">
                        <rect x="640" y="35" width="200" height="70" rx="16" fill="#0d0d0d" stroke="#25D366" stroke-width="1.5"/>
                        <use href="#waIcon" x="666" y="57" width="26" height="26" fill="#25D366"/>
                        <text x="706" y="76" text-anchor="start" class="rp-node-title">Grupo 01</text>
                    </g>
                    <g filter="url(#rpShadow)">
                        <rect x="640" y="115" width="200" height="70" rx="16" fill="#0d0d0d" stroke="#25D366" stroke-width="1.5"/>
                        <use href="#waIcon" x="666" y="137" width="26" height="26" fill="#25D366"/>
                        <text x="706" y="156" text-anchor="start" class="rp-node-title">Grupo 02</text>
                    </g>
                    <g filter="url(#rpShadow)">
                        <rect x="640" y="195" width="200" height="70" rx="16" fill="#0d0d0d" stroke="#25D366" stroke-width="1.5"/>
                        <use href="#waIcon" x="666" y="217" width="26" height="26" fill="#25D366"/>
                        <text x="706" y="236" text-anchor="start" class="rp-node-title">Grupo 03</text>
                    </g>
                    <text x="740" y="292" text-anchor="middle" class="rp-caption-orange">sua comissão</text>
                </svg>
            </div>

            <!-- ===== DIAGRAMA: MOBILE ===== -->
            <div class="mt-12 md:hidden">
                <svg viewBox="0 0 320 620" xmlns="http://www.w3.org/2000/svg" class="w-full" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Fluxo do Modo Repasse: grupo de ofertas, Nimbus troca o link, seus grupos">
                    <defs>
                        <symbol id="waIconM" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></symbol>
                        <marker id="rpmArrowGray" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                            <path d="M 0 0 L 10 5 L 0 10 z" fill="#6b7280"/>
                        </marker>
                        <marker id="rpmArrowOrange" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                            <path d="M 0 0 L 10 5 L 0 10 z" fill="#ff6a00"/>
                        </marker>
                    </defs>

                    <!-- entrada -->
                    <path id="rpmIn" d="M 160 168 L 160 212" fill="none" stroke="#6b7280" stroke-width="1.5" stroke-opacity="0.55" marker-end="url(#rpmArrowGray)"/>
                    <circle r="4" fill="#6b7280">
                        <animateMotion dur="3s" repeatCount="indefinite"><mpath href="#rpmIn"/></animateMotion>
                        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.2;0.85;1" dur="3s" repeatCount="indefinite"/>
                    </circle>

                    <!-- saídas -->
                    <path id="rpmOut1" d="M 160 345 C 160 380, 80 385, 80 425" fill="none" stroke="#ff6a00" stroke-width="1.5" stroke-opacity="0.6" marker-end="url(#rpmArrowOrange)"/>
                    <path id="rpmOut2" d="M 160 345 L 160 425" fill="none" stroke="#ff6a00" stroke-width="1.5" stroke-opacity="0.6" marker-end="url(#rpmArrowOrange)"/>
                    <path id="rpmOut3" d="M 160 345 C 160 380, 240 385, 240 425" fill="none" stroke="#ff6a00" stroke-width="1.5" stroke-opacity="0.6" marker-end="url(#rpmArrowOrange)"/>
                    <circle r="4" fill="#ff6a00">
                        <animateMotion dur="3s" begin="1.4s" repeatCount="indefinite"><mpath href="#rpmOut1"/></animateMotion>
                        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="3s" begin="1.4s" repeatCount="indefinite"/>
                    </circle>
                    <circle r="4" fill="#ff6a00">
                        <animateMotion dur="3s" begin="1.5s" repeatCount="indefinite"><mpath href="#rpmOut2"/></animateMotion>
                        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="3s" begin="1.5s" repeatCount="indefinite"/>
                    </circle>
                    <circle r="4" fill="#ff6a00">
                        <animateMotion dur="3s" begin="1.6s" repeatCount="indefinite"><mpath href="#rpmOut3"/></animateMotion>
                        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="3s" begin="1.6s" repeatCount="indefinite"/>
                    </circle>

                    <!-- fonte -->
                    <rect x="50" y="30" width="220" height="90" rx="18" fill="#141414" stroke="#4b5563" stroke-width="1.5"/>
                    <use href="#waIconM" x="72" y="58" width="24" height="24" fill="#6b7280"/>
                    <text x="108" y="71" text-anchor="start" class="rp-node-title">Grupo de ofertas</text>
                    <text x="108" y="93" text-anchor="start" class="rp-node-sub">fonte que você acompanha</text>
                    <text x="160" y="146" text-anchor="middle" class="rp-caption-gray">comissão de outro afiliado</text>

                    <!-- nimbus -->
                    <rect x="98" y="215" width="124" height="120" rx="24" fill="#0d0d0d" stroke="#ff6a00" stroke-width="2"/>
                    <image href="/imagens/nimbus.png" x="115" y="230" width="90" height="90" preserveAspectRatio="xMidYMid meet"/>
                    <text x="234" y="282" text-anchor="start" class="rp-caption-orange">link trocado</text>

                    <!-- grupos -->
                    <rect x="20" y="425" width="90" height="70" rx="14" fill="#0d0d0d" stroke="#25D366" stroke-width="1.5"/>
                    <use href="#waIconM" x="55" y="437" width="20" height="20" fill="#25D366"/>
                    <text x="65" y="482" text-anchor="middle" class="rp-node-sm">Grupo 01</text>
                    <rect x="115" y="425" width="90" height="70" rx="14" fill="#0d0d0d" stroke="#25D366" stroke-width="1.5"/>
                    <use href="#waIconM" x="150" y="437" width="20" height="20" fill="#25D366"/>
                    <text x="160" y="482" text-anchor="middle" class="rp-node-sm">Grupo 02</text>
                    <rect x="210" y="425" width="90" height="70" rx="14" fill="#0d0d0d" stroke="#25D366" stroke-width="1.5"/>
                    <use href="#waIconM" x="245" y="437" width="20" height="20" fill="#25D366"/>
                    <text x="255" y="482" text-anchor="middle" class="rp-node-sm">Grupo 03</text>
                    <text x="160" y="535" text-anchor="middle" class="rp-caption-orange">sua comissão</text>
                </svg>
            </div>

            <!-- ===== TRÊS MOVIMENTOS ===== -->
            <div class="mt-14 grid gap-8 md:grid-cols-3">
                <div>
                    <div class="flex items-center gap-3 mb-3">
                        <span class="rp-step-num">1</span>
                        <h3 class="font-display text-lg font-semibold text-white">Escolha a fonte</h3>
                    </div>
                    <p class="text-white/55 leading-relaxed">Um grupo ou canal de ofertas que você já acompanha e confia. Você aproveita a curadoria que já está pronta.</p>
                </div>
                <div>
                    <div class="flex items-center gap-3 mb-3">
                        <span class="rp-step-num">2</span>
                        <h3 class="font-display text-lg font-semibold text-white">A Nimbus troca o link</h3>
                    </div>
                    <p class="text-white/55 leading-relaxed">Cada oferta que chega sai com o seu link de afiliado no lugar do original. Você não abre o celular.</p>
                </div>
                <div>
                    <div class="flex items-center gap-3 mb-3">
                        <span class="rp-step-num">3</span>
                        <h3 class="font-display text-lg font-semibold text-white">Repasse no automático</h3>
                    </div>
                    <p class="text-white/55 leading-relaxed">A oferta reaparece nos seus grupos, com a sua comissão. Você configura uma vez e não toca mais.</p>
                </div>
            </div>


        </div>
    </section>
    <!-- ============== SEM / COM A NIMBUS ============== -->
    <section class="px-6 py-16 md:py-24 bg-white">
        <div class="mx-auto max-w-5xl">
            <div class="mb-16 text-center">
                <span class="inline-block text-xs font-semibold tracking-widest uppercase mb-4" style="color:var(--color-brand)">O problema</span>
                <h2 class="font-display text-3xl md:text-5xl font-bold leading-tight" style="color:var(--color-ink)">
                    Por que a <span style="color:var(--color-brand)">Nimbus?</span>
                </h2>
            </div>

            <div class="grid gap-5 md:grid-cols-2">

                <!-- SEM A NIMBUS -->
                <div class="compare-col compare-without">
                    <p class="compare-head">Sem a Nimbus</p>
                    <p class="compare-item"><span class="compare-mark compare-mark-x"><i data-lucide="x"></i></span>Perde as melhores ofertas porque não estava olhando na hora</p>
                    <p class="compare-item"><span class="compare-mark compare-mark-x"><i data-lucide="x"></i></span>Passa o dia postando, grupo por grupo, no dedo</p>
                    <p class="compare-item"><span class="compare-mark compare-mark-x"><i data-lucide="x"></i></span>Reescreve o mesmo texto a cada oferta nova</p>
                    <p class="compare-item"><span class="compare-mark compare-mark-x"><i data-lucide="x"></i></span>Baixa e monta a imagem antes de cada post</p>
                    <p class="compare-item"><span class="compare-mark compare-mark-x"><i data-lucide="x"></i></span>Copia oferta por oferta de outros grupos, na mão</p>
                </div>

                <!-- COM A NIMBUS -->
                <div class="compare-col compare-with">
                    <p class="compare-head">Com a Nimbus</p>
                    <p class="compare-item"><span class="compare-mark compare-mark-check"><i data-lucide="check"></i></span>As ofertas relevantes chegam sozinhas, o dia inteiro</p>
                    <p class="compare-item"><span class="compare-mark compare-mark-check"><i data-lucide="check"></i></span>Conecta uma vez e a operação roda sem você</p>
                    <p class="compare-item"><span class="compare-mark compare-mark-check"><i data-lucide="check"></i></span>A mensagem sai pronta, no seu padrão</p>
                    <p class="compare-item"><span class="compare-mark compare-mark-check"><i data-lucide="check"></i></span>A imagem já vem junto com a oferta</p>
                    <p class="compare-item"><span class="compare-mark compare-mark-check"><i data-lucide="check"></i></span><strong>Modo Repasse</strong></p>
                </div>

            </div>
        </div>
    </section>
    <!-- ============== COMO FUNCIONA ============== -->
    <section id="como-funciona" class="px-6 py-16 md:py-24" style="background:var(--color-bg-soft)">
        <div class="mx-auto max-w-4xl">
            <div class="mb-16">
                <span class="inline-block text-xs font-semibold tracking-widest uppercase mb-4" style="color:var(--color-brand)">Como funciona</span>
                <h2 class="font-display text-3xl md:text-5xl font-bold leading-tight" style="color:var(--color-ink)">
                    Sua primeira campanha no ar<br>
                    em <span style="color:var(--color-brand)">poucos minutos.</span>
                </h2>
            </div>

            <ol class="space-y-10">
                <li class="flex gap-6 md:gap-8">
                    <span class="step-num">01</span>
                    <div>
                        <h3 class="font-display font-semibold text-xl mb-2" style="color:var(--color-ink)">Conecte o seu WhatsApp</h3>
                        <p class="text-stone-600 leading-relaxed">Você escaneia um QR code, igual ao WhatsApp Web, e escolhe quais dos seus grupos vão receber as ofertas. Leva menos de um minuto e não instala nada no celular.</p>
                    </div>
                </li>
                <li class="flex gap-6 md:gap-8">
                    <span class="step-num">02</span>
                    <div>
                        <h3 class="font-display font-semibold text-xl mb-2" style="color:var(--color-ink)">Diga o que você quer postar</h3>
                        <p class="text-stone-600 leading-relaxed">Escolha as categorias que combinam com o seu público, ou aponte uma fonte para o Modo Repasse. Depois é só definir como as suas mensagens devem sair — a partir daí, toda oferta já vem pronta nesse padrão, com imagem e com o seu link.</p>
                    </div>
                </li>
                <li class="flex gap-6 md:gap-8">
                    <span class="step-num">03</span>
                    <div>
                        <h3 class="font-display font-semibold text-xl mb-2" style="color:var(--color-ink)">Escolha os horários e pronto</h3>
                        <p class="text-stone-600 leading-relaxed">Você define quando as ofertas saem e a operação passa a rodar sozinha. Do lado de fora, é o seu grupo entregando promoção o dia inteiro. Do seu lado, é você não abrindo mais o celular para isso.</p>
                    </div>
                </li>
            </ol>

            <p class="mt-12 text-stone-500 border-t border-stone-200 pt-8">
                Depois da primeira configuração, você só volta ao painel quando quiser mudar alguma coisa.
            </p>

            <div class="mt-10">
                <a href="#teste" class="btn-primary inline-flex items-center gap-2 rounded-2xl px-7 py-4 text-base font-semibold">
                    <span>Começar agora</span>
                    <i data-lucide="arrow-right"></i>
                </a>
            </div>
        </div>
    </section>

    <!-- ============== VIDEO DEMO ============== -->
    <section id="video-demo" class="px-6 py-16 md:py-24 bg-white">
        <div class="mx-auto max-w-5xl">
            <div class="text-center mb-10">
                <span class="inline-block text-xs font-semibold tracking-widest uppercase mb-4" style="color:var(--color-brand)">Veja em ação</span>
                <h3 class="font-display text-3xl md:text-4xl font-bold leading-tight" style="color:var(--color-ink)">
                    Como a <span style="color:var(--color-brand)">Nimbus</span> funciona na prática.
                </h3>
            </div>
            <div class="relative rounded-3xl overflow-hidden border border-stone-200 shadow-2xl" style="aspect-ratio: 16/9; background:#0d0d0d">
                <iframe
                    src="https://www.youtube.com/embed/VIecfv5IlL0"
                    title="Nimbus - Como Funciona"
                    frameborder="0"
                    loading="lazy"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    referrerpolicy="strict-origin-when-cross-origin"
                    allowfullscreen
                    class="absolute inset-0 w-full h-full">
                </iframe>
            </div>
        </div>
    </section>

    <!-- ============== TESTE 7 DIAS POR R$ 1,00 ============== -->
    <section id="teste" class="hero-dark relative overflow-hidden px-6 py-16 md:py-24">
        <div class="mx-auto max-w-4xl text-center relative">
            <h2 class="font-display text-3xl md:text-5xl font-bold leading-[1.12] text-white mb-4">
                Você não precisa acreditar em nada do que leu até aqui.
            </h2>
            <p class="font-display text-4xl md:text-6xl font-extrabold mb-10" style="color:var(--color-brand)">
                Teste 7 dias por R$ 1,00.
            </p>

            <div class="space-y-5 text-lg leading-relaxed text-white/60 max-w-2xl mx-auto">
                <p>Um real é o suficiente para você conectar o seu WhatsApp, montar a primeira campanha e ver as ofertas saindo nos seus grupos. Em sete dias você não está testando um painel — está vendo a sua operação rodar sem você.</p>
                <p>Se não for o que você esperava, é só cancelar antes do fim do período. Não tem multa, não tem fidelidade, não tem conversa para segurar você.</p>
            </div>

            <div class="mt-10 flex flex-col sm:flex-row items-center justify-center gap-5 sm:gap-10">
                <span class="test-badge">
                    <span class="test-badge-icon"><i data-lucide="check"></i></span>
                    Acesso completo
                </span>
                <span class="test-badge">
                    <span class="test-badge-icon"><i data-lucide="check"></i></span>
                    Cancele quando quiser
                </span>
            </div>

            <div class="mt-12">
                <a href="https://sistema.nimbuspromocoes.com/assinar?plano=basic&teste=1" data-lead-plan="comecar" data-lead-label="teste de 7 dias por R$ 1,00" class="btn-primary inline-flex items-center justify-center gap-2 rounded-2xl px-8 py-4 text-base font-semibold">
                    <span>Começar por R$ 1,00</span>
                    <i data-lucide="arrow-right"></i>
                </a>
                <p class="mt-4 text-sm text-white/40">Leva menos de dois minutos para conectar.</p>
            </div>
        </div>
    </section>
    <!-- ============== PLANOS ============== -->
    <section id="planos" class="px-6 py-16 md:py-24" style="background:var(--color-bg-soft)">
        <div class="mx-auto max-w-7xl">
            <div class="mb-16 text-center">
                <span class="inline-block text-xs font-semibold tracking-widest uppercase mb-4" style="color:var(--color-brand)">Planos</span>
                <h2 class="font-display text-3xl md:text-5xl font-bold leading-tight max-w-3xl mx-auto" style="color:var(--color-ink)">
                    Escolha o plano e <span style="color:var(--color-brand)">comece a vender no piloto automático.</span>
                </h2>
                <div class="mt-6 inline-flex items-center gap-2 text-sm text-stone-600">
                    <i data-lucide="shield-check" style="color:var(--color-brand)"></i>
                    <span>Todos os planos começam com <strong>7 dias por R$ 1,00</strong> e <strong>sem fidelidade</strong></span>
                </div>
            </div>

            <div class="grid gap-6 md:grid-cols-3 items-stretch">
                <!-- BRONZE -->
                <div class="card-soft rounded-2xl p-8 flex flex-col">
                    <div class="mb-6">
                        <h3 class="font-display text-sm font-semibold uppercase tracking-widest text-stone-500 mb-2">Bronze</h3>
                        <p class="font-display text-4xl font-bold" style="color:var(--color-ink)">R$ 69<span class="text-xl text-stone-400">,90</span><span class="text-sm font-medium text-stone-500">/mês</span></p>
                        <p class="text-sm text-stone-500 mt-1">Equivale a R$ 2,33/dia</p>
                    </div>
                    <ul class="space-y-3 mb-8 text-sm flex-grow">
                        <li class="flex gap-3"><i data-lucide="check" style="color:var(--color-brand);flex-shrink:0;margin-top:2px"></i>1 WhatsApp conectado</li>
                        <li class="flex gap-3"><i data-lucide="check" style="color:var(--color-brand);flex-shrink:0;margin-top:2px"></i>1 campanha ativa</li>
                        <li class="flex gap-3"><i data-lucide="check" style="color:var(--color-brand);flex-shrink:0;margin-top:2px"></i>3 grupos conectados</li>
                        <li class="flex gap-3"><i data-lucide="check" style="color:var(--color-brand);flex-shrink:0;margin-top:2px"></i>Programação de envios</li>
                        <li class="flex gap-3"><i data-lucide="check" style="color:var(--color-brand);flex-shrink:0;margin-top:2px"></i>Catálogo de ofertas</li>
                        <li class="flex gap-3"><i data-lucide="check" style="color:var(--color-brand);flex-shrink:0;margin-top:2px"></i>Filtro inteligente</li>
                        <li class="flex gap-3"><i data-lucide="check" style="color:var(--color-brand);flex-shrink:0;margin-top:2px"></i><strong>Modo Repasse</strong></li>
                    </ul>
                    <button type="button" data-lead-plan="bronze" data-lead-label="Plano Bronze" data-lead-redirect="https://sistema.nimbuspromocoes.com/assinar?plano=basic" class="w-full bg-white border-2 border-stone-900 text-stone-900 py-3.5 rounded-2xl font-semibold hover:bg-stone-900 hover:text-white transition-colors">Assinar Bronze</button>
                </div>

                <!-- PRATA (destaque) -->
                <div class="plan-highlight rounded-2xl p-8 flex flex-col relative shadow-2xl md:scale-105">
                    <span class="absolute -top-3 left-1/2 -translate-x-1/2 text-white px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest" style="background:var(--color-brand)">Mais Escolhido</span>
                    <div class="mb-6">
                        <h3 class="font-display text-sm font-semibold uppercase tracking-widest text-white/50 mb-2">Prata</h3>
                        <p class="font-display text-4xl font-bold plan-price">R$ 99<span class="text-xl opacity-60">,90</span><span class="text-sm font-medium text-white/50">/mês</span></p>
                        <p class="text-sm text-white/50 mt-1">Equivale a R$ 3,33/dia</p>
                    </div>
                    <ul class="space-y-3 mb-8 text-sm text-white/90 flex-grow">
                        <li class="flex gap-3"><i data-lucide="check" style="color:var(--color-brand);flex-shrink:0;margin-top:2px"></i>3 WhatsApp conectados</li>
                        <li class="flex gap-3"><i data-lucide="check" style="color:var(--color-brand);flex-shrink:0;margin-top:2px"></i>5 campanhas ativas</li>
                        <li class="flex gap-3"><i data-lucide="check" style="color:var(--color-brand);flex-shrink:0;margin-top:2px"></i>15 grupos conectados</li>
                        <li class="flex gap-3"><i data-lucide="check" style="color:var(--color-brand);flex-shrink:0;margin-top:2px"></i>Programação de envios</li>
                        <li class="flex gap-3"><i data-lucide="check" style="color:var(--color-brand);flex-shrink:0;margin-top:2px"></i>Catálogo de ofertas</li>
                        <li class="flex gap-3"><i data-lucide="check" style="color:var(--color-brand);flex-shrink:0;margin-top:2px"></i>Filtro inteligente</li>
                        <li class="flex gap-3"><i data-lucide="check" style="color:var(--color-brand);flex-shrink:0;margin-top:2px"></i><strong>Modo Repasse</strong></li>
                    </ul>
                    <button type="button" data-lead-plan="prata" data-lead-label="Plano Prata" data-lead-redirect="https://sistema.nimbuspromocoes.com/assinar?plano=pro" class="btn-primary w-full py-3.5 rounded-2xl font-semibold inline-flex items-center justify-center gap-2">
                        <span>Assinar Prata</span>
                        <i data-lucide="arrow-right" style="width:18px;height:18px"></i>
                    </button>
                </div>

                <!-- OURO -->
                <div class="card-soft rounded-2xl p-8 flex flex-col">
                    <div class="mb-6">
                        <h3 class="font-display text-sm font-semibold uppercase tracking-widest text-stone-500 mb-2">Ouro</h3>
                        <p class="font-display text-4xl font-bold" style="color:var(--color-ink)">R$ 149<span class="text-xl text-stone-400">,90</span><span class="text-sm font-medium text-stone-500">/mês</span></p>
                        <p class="text-sm text-stone-500 mt-1">Equivale a R$ 5,00/dia</p>
                    </div>
                    <ul class="space-y-3 mb-8 text-sm flex-grow">
                        <li class="flex gap-3"><i data-lucide="check" style="color:var(--color-brand);flex-shrink:0;margin-top:2px"></i>5 WhatsApp conectados</li>
                        <li class="flex gap-3"><i data-lucide="check" style="color:var(--color-brand);flex-shrink:0;margin-top:2px"></i>Campanhas ilimitadas</li>
                        <li class="flex gap-3"><i data-lucide="check" style="color:var(--color-brand);flex-shrink:0;margin-top:2px"></i>Grupos ilimitados</li>
                        <li class="flex gap-3"><i data-lucide="check" style="color:var(--color-brand);flex-shrink:0;margin-top:2px"></i>Programação de envios</li>
                        <li class="flex gap-3"><i data-lucide="check" style="color:var(--color-brand);flex-shrink:0;margin-top:2px"></i>Catálogo de ofertas</li>
                        <li class="flex gap-3"><i data-lucide="check" style="color:var(--color-brand);flex-shrink:0;margin-top:2px"></i>Filtro inteligente</li>
                        <li class="flex gap-3"><i data-lucide="check" style="color:var(--color-brand);flex-shrink:0;margin-top:2px"></i><strong>Modo Repasse</strong></li>
                    </ul>
                    <button type="button" data-lead-plan="ouro" data-lead-label="Plano Ouro" data-lead-redirect="https://sistema.nimbuspromocoes.com/assinar?plano=business" class="w-full bg-white border-2 border-stone-900 text-stone-900 py-3.5 rounded-2xl font-semibold hover:bg-stone-900 hover:text-white transition-colors">Assinar Ouro</button>
                </div>
            </div>

            <!-- ===== CONTATO WHATSAPP ===== -->
            <div class="mt-14 text-center">
                <p class="text-stone-600 mb-5">Ficou com dúvida antes de assinar? Chama no WhatsApp.</p>
                <a href="https://wa.me/5555997140686?text=Ol%C3%A1!%20Vim%20pelo%20site%20e%20quero%20saber%20mais%20sobre%20a%20Nimbus."
                   target="_blank" rel="noopener"
                   class="btn-whatsapp inline-flex items-center justify-center gap-3 rounded-2xl px-7 py-4 text-base font-semibold">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>
                    <span>(55) 99714-0686</span>
                </a>
            </div>
        </div>
    </section>

    <!-- ============== FAQ ============== -->
    <section class="px-6 py-16 md:py-24" style="background:var(--color-bg-soft)">
        <div class="mx-auto max-w-3xl">
            <div class="mb-16 text-center">
                <span class="inline-block text-xs font-semibold tracking-widest uppercase mb-4" style="color:var(--color-brand)">FAQ</span>
                <h2 class="font-display text-3xl md:text-5xl font-bold leading-tight" style="color:var(--color-ink)">Dúvidas frequentes</h2>
            </div>

            <div class="space-y-3">
                <details class="faq-item bg-white border border-stone-200 rounded-2xl overflow-hidden group">
                    <summary class="px-6 py-5 flex justify-between items-center gap-4">
                        <span class="font-display font-semibold text-base md:text-lg" style="color:var(--color-ink)">Preciso entender de tecnologia para usar?</span>
                        <i data-lucide="chevron-down" class="faq-chevron shrink-0" style="color:var(--color-brand)"></i>
                    </summary>
                    <div class="px-6 pb-6 text-stone-600 leading-relaxed">
                        Não. A Nimbus foi feita para quem opera grupo de promoção, não para quem programa. Você conecta o WhatsApp escaneando um QR code, escolhe os grupos e define os horários — tudo por telas simples, sem instalar nada e sem configurar nada técnico. Se travar em algum ponto, você chama no WhatsApp e alguém te ajuda a deixar a primeira campanha no ar.
                    </div>
                </details>
                <details class="faq-item bg-white border border-stone-200 rounded-2xl overflow-hidden group">
                    <summary class="px-6 py-5 flex justify-between items-center gap-4">
                        <span class="font-display font-semibold text-base md:text-lg" style="color:var(--color-ink)">Preciso ter grupo de WhatsApp criado?</span>
                        <i data-lucide="chevron-down" class="faq-chevron shrink-0" style="color:var(--color-brand)"></i>
                    </summary>
                    <div class="px-6 pb-6 text-stone-600 leading-relaxed">
                        Sim. Você precisa ser administrador dos grupos que quer usar. Na configuração, você indica pelo link quais grupos entram em cada campanha.
                    </div>
                </details>
                <details class="faq-item bg-white border border-stone-200 rounded-2xl overflow-hidden group">
                    <summary class="px-6 py-5 flex justify-between items-center gap-4">
                        <span class="font-display font-semibold text-base md:text-lg" style="color:var(--color-ink)">Preciso deixar o celular ligado o tempo todo?</span>
                        <i data-lucide="chevron-down" class="faq-chevron shrink-0" style="color:var(--color-brand)"></i>
                    </summary>
                    <div class="px-6 pb-6 text-stone-600 leading-relaxed">
                        Não. Você conecta uma vez na Nimbus e ela roda sozinha.
                    </div>
                </details>
                <details class="faq-item bg-white border border-stone-200 rounded-2xl overflow-hidden group">
                    <summary class="px-6 py-5 flex justify-between items-center gap-4">
                        <span class="font-display font-semibold text-base md:text-lg" style="color:var(--color-ink)">Preciso ser afiliado cadastrado nas lojas?</span>
                        <i data-lucide="chevron-down" class="faq-chevron shrink-0" style="color:var(--color-brand)"></i>
                    </summary>
                    <div class="px-6 pb-6 text-stone-600 leading-relaxed">
                        Sim. Você usa as suas próprias contas de afiliado, para que as comissões caiam direto para você. O cadastro é gratuito e feito no site de cada loja — se precisar, a gente te orienta pelo WhatsApp.
                    </div>
                </details>
                <details class="faq-item bg-white border border-stone-200 rounded-2xl overflow-hidden group">
                    <summary class="px-6 py-5 flex justify-between items-center gap-4">
                        <span class="font-display font-semibold text-base md:text-lg" style="color:var(--color-ink)">O que é o Modo Repasse?</span>
                        <i data-lucide="chevron-down" class="faq-chevron shrink-0" style="color:var(--color-brand)"></i>
                    </summary>
                    <div class="px-6 pb-6 text-stone-600 leading-relaxed">
                        É o recurso que pega as ofertas de uma fonte que você já acompanha e republica nos seus grupos com o seu link de afiliado, automaticamente. Você aponta a fonte uma vez e a Nimbus faz o resto — a oferta é a mesma, a comissão passa a ser sua. Funciona com qualquer canal público de ofertas, inclusive os seus próprios, se você quiser espelhar de um grupo para todos os outros.
                    </div>
                </details>
                <details class="faq-item bg-white border border-stone-200 rounded-2xl overflow-hidden group">
                    <summary class="px-6 py-5 flex justify-between items-center gap-4">
                        <span class="font-display font-semibold text-base md:text-lg" style="color:var(--color-ink)">Quais lojas estão integradas?</span>
                        <i data-lucide="chevron-down" class="faq-chevron shrink-0" style="color:var(--color-brand)"></i>
                    </summary>
                    <div class="px-6 pb-6 text-stone-600 leading-relaxed">
                        Mercado Livre e Shopee. Novos parceiros entram no catálogo periodicamente. Se você trabalha com alguma loja específica, mande a sugestão pelo WhatsApp.
                    </div>
                </details>
                <details class="faq-item bg-white border border-stone-200 rounded-2xl overflow-hidden group">
                    <summary class="px-6 py-5 flex justify-between items-center gap-4">
                        <span class="font-display font-semibold text-base md:text-lg" style="color:var(--color-ink)">O que acontece quando terminam os 7 dias?</span>
                        <i data-lucide="chevron-down" class="faq-chevron shrink-0" style="color:var(--color-brand)"></i>
                    </summary>
                    <div class="px-6 pb-6 text-stone-600 leading-relaxed">
                        O teste vira assinatura do plano Bronze automaticamente, e a cobrança mensal começa a partir daí. Se você não quiser continuar, é só cancelar antes do fim dos 7 dias — sem multa e sem precisar justificar. Você pode também subir de plano a qualquer momento, se precisar de mais grupos ou mais números conectados.
                    </div>
                </details>
                <details class="faq-item bg-white border border-stone-200 rounded-2xl overflow-hidden group">
                    <summary class="px-6 py-5 flex justify-between items-center gap-4">
                        <span class="font-display font-semibold text-base md:text-lg" style="color:var(--color-ink)">Posso cancelar a qualquer momento?</span>
                        <i data-lucide="chevron-down" class="faq-chevron shrink-0" style="color:var(--color-brand)"></i>
                    </summary>
                    <div class="px-6 pb-6 text-stone-600 leading-relaxed">
                        Sim. Não há fidelidade nem multa. O cancelamento é feito nas configurações da conta, e o acesso continua ativo até o fim do período já pago.
                    </div>
                </details>
            </div>

            <div class="mt-16 text-center">
                <p class="text-stone-600 mb-6">Pronto pra deixar a operação rodando sozinha?</p>
                <a href="#teste" class="btn-primary inline-flex items-center gap-2 rounded-2xl px-7 py-4 text-base font-semibold">
                    <span>Testar por R$ 1,00</span>
                    <i data-lucide="arrow-right"></i>
                </a>
            </div>
        </div>
    </section>
    <!-- ============== FOOTER ============== -->
    <footer class="bg-stone-950 text-white py-16 px-6">
        <div class="mx-auto max-w-7xl">

            <div class="grid gap-10 md:grid-cols-3 pb-10 border-b border-white/10">
                <div class="md:col-span-2">
                    <p class="font-display font-bold text-2xl tracking-tight mb-2">Nimbus<span style="color:var(--color-brand)">.</span></p>
                    <p class="text-sm text-white/60 max-w-xs leading-relaxed">Automação para WhatsApp focada em afiliados. Ofertas selecionadas, mensagem pronta e disparo no horário que você definir.</p>
                </div>

<div>
                    <p class="text-xs font-semibold uppercase tracking-widest text-white/40 mb-4">Institucional</p>
                    <ul class="space-y-2.5 text-sm text-white/70">
                        <!-- TODO: criar estas duas páginas antes de subir campanha no Meta -->
                        <li><a href="/privacidade.php" class="hover:text-white transition-colors">Política de privacidade</a></li>
                        <li><a href="/termos.php" class="hover:text-white transition-colors">Termos de uso</a></li>
                        <li><a href="/" class="hover:text-white transition-colors">Grupos de ofertas</a></li>
                    </ul>
                </div>
            </div>

            <div class="mt-8 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <p class="text-xs text-white/40">
                    &copy; 2026 Nimbus Promoções.
                    <!--
                    Selo de versao: serve pra confirmar, olhando o rodape do site
                    publicado, QUAL versao da landing esta no ar. Ao mexer nesta
                    pagina ou no lead-modal.php, suba a data/numero nos DOIS
                    arquivos (o modal usa o mesmo valor em NIMBUS_LP_VERSION).
                    -->
                    <span class="text-white/40" title="Versão da landing publicada">v2026-07-31.2</span>
                </p>
                <!-- TODO: incluir razão social e CNPJ -->
            </div>
        </div>
    </footer>

    <script>
        // Inicializa Lucide
        document.addEventListener('DOMContentLoaded', () => {
            if (window.lucide) lucide.createIcons();
        });

        // Scroll suave sem alterar a URL (mantém o histórico e o analytics limpos)
        document.addEventListener('click', function (e) {
            const a = e.target.closest('a[href^="#"]');
            if (!a) return;
            const id = a.getAttribute('href').slice(1);
            if (!id) return;
            const el = document.getElementById(id);
            if (!el) return;
            e.preventDefault();
            const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
        });
        // Reinicializa em casos de Alpine etc
        window.addEventListener('load', () => {
            if (window.lucide) lucide.createIcons();
        });
    </script>
    <?php include __DIR__ . '/lead-modal.php'; ?>
</body>
</html>
