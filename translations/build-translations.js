/*
Generate the TiddlyDesktop WikiList translations for every language TiddlyWiki ships.

Each language plugin has plugin-priority 100 (the tiddlydesktop plugin has 0), and TW's
PluginSwitcher activates only the language selected via $:/language. So a translated
`$:/language/TiddlyDesktop/...` tiddler placed inside a language plugin overrides the
plugin's English default whenever that language is active — no UI changes needed.

This script writes, for each language:
  translations/<lang>/TiddlyDesktop.multids   (the single-line strings)
  translations/<lang>/EmptyMessage.tid        (the multi-line empty-list message)
bld.sh copies these into source/tiddlywiki/languages/<lang>/ after it (re)copies the TW
core, so they become part of each language plugin's payload at boot.

Translations are best-effort; any key omitted for a language simply falls back to the
plugin's English (the language shadow only overrides keys it defines). English variants
(en-GB/en-US/en-PH) are intentionally not generated.
*/

"use strict";

var fs = require("fs"), path = require("path");

// Ordered list of string keys (kept in sync with plugins/tiddlydesktop/language/TiddlyDesktop.multids).
var KEY_ORDER = [
	"Toolbar/AddWikiFile","Toolbar/AddWikiFolder","Toolbar/Backstage","Toolbar/CreateWikiFolder",
	"Toolbar/CreateWiki","Toolbar/CreateFromTemplate","Toolbar/NoTemplates","Toolbar/From",
	"Toolbar/CloneExisting","Toolbar/NoWikisToClone","Toolbar/Help","Toolbar/Settings","Toolbar/Language",
	"List/SearchPlaceholder","List/ClearSearch",
	"Row/Untitled","Row/Open","Row/Reveal","Row/Remove","Row/ToFolder","Row/ToFile",
	"Row/ToFolderTooltip","Row/ToFileTooltip","Row/Advanced","Row/Plugins",
	"Advanced/Backups","Advanced/SaveBackup","Advanced/RevealBackups","Advanced/ServerNote",
	"Advanced/Server","Advanced/Host","Advanced/Port","Advanced/PathPrefix","Advanced/RootTiddler",
	"Advanced/Gzip","Advanced/Access","Advanced/Credentials","Advanced/AnonUsername",
	"Advanced/Readers","Advanced/Writers",
	"PluginChooser/Tab/plugin","PluginChooser/Tab/language","PluginChooser/Tab/theme",
	"PluginChooser/Heading","PluginChooser/Close","PluginChooser/OpenWarning","PluginChooser/FilterPlaceholder",
	"PluginChooser/Clear","PluginChooser/NoMatch","PluginChooser/Apply","PluginChooser/Cancel",
	"PluginChooser/Update","PluginChooser/UpdateAvailable","PluginChooser/Updated","Row/PluginUpdates"
];

// key -> { _empty: <multi-line empty message>, <key>: <value>, ... } per language.
var T = {};

T["de-DE"] = {
	_empty: "Füge eine ~TiddlyWiki-Datei oder einen Ordner hinzu, um zu beginnen.\n\nKlicke oben auf die Schaltflächen zum Durchsuchen oder ziehe Dateien aus deinem Datei-Explorer/Finder hierher.",
	"Toolbar/AddWikiFile":"Wiki-Datei hinzufügen","Toolbar/AddWikiFolder":"Wiki-Ordner hinzufügen","Toolbar/Backstage":"Backstage",
	"Toolbar/CreateWikiFolder":"Neuen Wiki-Ordner erstellen","Toolbar/CreateWiki":"Neues Wiki erstellen","Toolbar/CreateFromTemplate":"Aus einer Vorlage erstellen",
	"Toolbar/NoTemplates":"Keine Vorlagen definiert – siehe Einstellungen","Toolbar/From":"aus","Toolbar/CloneExisting":"Bestehendes Wiki klonen",
	"Toolbar/NoWikisToClone":"Keine Wikis zum Klonen verfügbar","Toolbar/Help":"Hilfe","Toolbar/Settings":"Einstellungen","Toolbar/Language":"Sprache",
	"List/SearchPlaceholder":"suchen","List/ClearSearch":"Suche löschen",
	"Row/Untitled":"Ohne Titel","Row/Open":"öffnen","Row/Reveal":"anzeigen","Row/Remove":"entfernen","Row/ToFolder":"in Ordner","Row/ToFile":"in Datei",
	"Row/ToFolderTooltip":"Wähle (oder erstelle) einen leeren Ordner für den neuen Wiki-Ordner","Row/ToFileTooltip":"Wähle, wo das neue Einzeldatei-Wiki gespeichert werden soll",
	"Row/Advanced":"erweitert","Row/Plugins":"Plugins",
	"Advanced/Backups":"Sicherungen","Advanced/SaveBackup":"Bei jedem Speichern eine Sicherung anlegen","Advanced/RevealBackups":"Sicherungen anzeigen",
	"Advanced/ServerNote":"Diese Optionen steuern, wie der Wiki-Ordner über HTTP bereitgestellt wird. Sie werden beim nächsten Öffnen des Wiki-Ordners wirksam.",
	"Advanced/Server":"Server","Advanced/Host":"Host","Advanced/Port":"Port","Advanced/PathPrefix":"Pfadpräfix","Advanced/RootTiddler":"Wurzel-Tiddler",
	"Advanced/Gzip":"Antworten komprimieren (gzip)","Advanced/Access":"Zugriff","Advanced/Credentials":"Anmeldedatei","Advanced/AnonUsername":"Anonymer Benutzername",
	"Advanced/Readers":"Leser","Advanced/Writers":"Schreiber",
	"PluginChooser/Heading":"Plugins verwalten","PluginChooser/Close":"Schließen","PluginChooser/OpenWarning":"Dieses Wiki ist derzeit geöffnet. Schließe zuerst sein Fenster und klicke dann auf Anwenden.",
	"PluginChooser/FilterPlaceholder":"Plugins filtern…","PluginChooser/Clear":"Löschen","PluginChooser/NoMatch":"Keine Plugins entsprechen deinem Filter.","PluginChooser/Apply":"Änderungen anwenden","PluginChooser/Cancel":"Abbrechen"
};

T["fr-FR"] = {
	_empty: "Ajoutez un fichier ou un dossier ~TiddlyWiki pour commencer.\n\nCliquez sur les boutons ci-dessus pour parcourir, ou glissez-déposez depuis votre explorateur de fichiers/Finder.",
	"Toolbar/AddWikiFile":"Ajouter un fichier wiki","Toolbar/AddWikiFolder":"Ajouter un dossier wiki","Toolbar/Backstage":"Coulisses",
	"Toolbar/CreateWikiFolder":"Créer un nouveau dossier wiki","Toolbar/CreateWiki":"Créer un nouveau wiki","Toolbar/CreateFromTemplate":"Créer à partir d’un modèle",
	"Toolbar/NoTemplates":"Aucun modèle défini – voir Paramètres","Toolbar/From":"de","Toolbar/CloneExisting":"Cloner un wiki existant",
	"Toolbar/NoWikisToClone":"Aucun wiki à cloner","Toolbar/Help":"Aide","Toolbar/Settings":"Paramètres","Toolbar/Language":"Langue",
	"List/SearchPlaceholder":"rechercher","List/ClearSearch":"Effacer la recherche",
	"Row/Untitled":"Sans titre","Row/Open":"ouvrir","Row/Reveal":"révéler","Row/Remove":"retirer","Row/ToFolder":"en dossier","Row/ToFile":"en fichier",
	"Row/ToFolderTooltip":"Choisissez (ou créez) un dossier vide pour le nouveau dossier wiki","Row/ToFileTooltip":"Choisissez où enregistrer le nouveau wiki en fichier unique",
	"Row/Advanced":"avancé","Row/Plugins":"plugins",
	"Advanced/Backups":"Sauvegardes","Advanced/SaveBackup":"Enregistrer une sauvegarde à chaque enregistrement","Advanced/RevealBackups":"révéler les sauvegardes",
	"Advanced/ServerNote":"Ces options contrôlent la façon dont le dossier wiki est servi via HTTP. Elles prennent effet à la prochaine ouverture du dossier wiki.",
	"Advanced/Server":"Serveur","Advanced/Host":"Hôte","Advanced/Port":"Port","Advanced/PathPrefix":"Préfixe de chemin","Advanced/RootTiddler":"Tiddler racine",
	"Advanced/Gzip":"Compresser les réponses (gzip)","Advanced/Access":"Accès","Advanced/Credentials":"Fichier d’identifiants","Advanced/AnonUsername":"Nom d’utilisateur anonyme",
	"Advanced/Readers":"Lecteurs","Advanced/Writers":"Rédacteurs",
	"PluginChooser/Heading":"Gérer les plugins","PluginChooser/Close":"Fermer","PluginChooser/OpenWarning":"Ce wiki est actuellement ouvert. Fermez d’abord sa fenêtre, puis cliquez sur Appliquer.",
	"PluginChooser/FilterPlaceholder":"Filtrer les plugins…","PluginChooser/Clear":"Effacer","PluginChooser/NoMatch":"Aucun plugin ne correspond à votre filtre.","PluginChooser/Apply":"Appliquer les modifications","PluginChooser/Cancel":"Annuler"
};

T["es-ES"] = {
	_empty: "Añade un archivo o una carpeta de ~TiddlyWiki para empezar.\n\nHaz clic en los botones de arriba para explorar, o arrastra y suelta desde tu explorador de archivos/Finder.",
	"Toolbar/AddWikiFile":"Añadir archivo wiki","Toolbar/AddWikiFolder":"Añadir carpeta wiki","Toolbar/Backstage":"Bastidores",
	"Toolbar/CreateWikiFolder":"Crear nueva carpeta wiki","Toolbar/CreateWiki":"Crear nuevo wiki","Toolbar/CreateFromTemplate":"Crear a partir de una plantilla",
	"Toolbar/NoTemplates":"No hay plantillas definidas: consulta Ajustes","Toolbar/From":"de","Toolbar/CloneExisting":"Clonar un wiki existente",
	"Toolbar/NoWikisToClone":"No hay wikis disponibles para clonar","Toolbar/Help":"Ayuda","Toolbar/Settings":"Ajustes","Toolbar/Language":"Idioma",
	"List/SearchPlaceholder":"buscar","List/ClearSearch":"Borrar búsqueda",
	"Row/Untitled":"Sin título","Row/Open":"abrir","Row/Reveal":"mostrar","Row/Remove":"quitar","Row/ToFolder":"a carpeta","Row/ToFile":"a archivo",
	"Row/ToFolderTooltip":"Elige (o crea) una carpeta vacía para la nueva carpeta wiki","Row/ToFileTooltip":"Elige dónde guardar el nuevo wiki de archivo único",
	"Row/Advanced":"avanzado","Row/Plugins":"complementos",
	"Advanced/Backups":"Copias de seguridad","Advanced/SaveBackup":"Guardar una copia de seguridad en cada guardado","Advanced/RevealBackups":"mostrar copias de seguridad",
	"Advanced/ServerNote":"Estas opciones controlan cómo se sirve la carpeta wiki por HTTP. Surten efecto la próxima vez que se abra la carpeta wiki.",
	"Advanced/Server":"Servidor","Advanced/Host":"Host","Advanced/Port":"Puerto","Advanced/PathPrefix":"Prefijo de ruta","Advanced/RootTiddler":"Tiddler raíz",
	"Advanced/Gzip":"Comprimir respuestas (gzip)","Advanced/Access":"Acceso","Advanced/Credentials":"Archivo de credenciales","Advanced/AnonUsername":"Nombre de usuario anónimo",
	"Advanced/Readers":"Lectores","Advanced/Writers":"Escritores",
	"PluginChooser/Heading":"Gestionar complementos","PluginChooser/Close":"Cerrar","PluginChooser/OpenWarning":"Este wiki está abierto actualmente. Cierra primero su ventana y luego haz clic en Aplicar.",
	"PluginChooser/FilterPlaceholder":"Filtrar complementos…","PluginChooser/Clear":"Borrar","PluginChooser/NoMatch":"Ningún complemento coincide con tu filtro.","PluginChooser/Apply":"Aplicar cambios","PluginChooser/Cancel":"Cancelar"
};

T["ca-ES"] = {
	_empty: "Afegeix un fitxer o una carpeta de ~TiddlyWiki per començar.\n\nFes clic als botons de dalt per explorar, o arrossega i deixa anar des del teu explorador de fitxers/Finder.",
	"Toolbar/AddWikiFile":"Afegeix un fitxer wiki","Toolbar/AddWikiFolder":"Afegeix una carpeta wiki","Toolbar/Backstage":"Rebost",
	"Toolbar/CreateWikiFolder":"Crea una carpeta wiki nova","Toolbar/CreateWiki":"Crea un wiki nou","Toolbar/CreateFromTemplate":"Crea a partir d’una plantilla",
	"Toolbar/NoTemplates":"No hi ha plantilles definides: vegeu Configuració","Toolbar/From":"de","Toolbar/CloneExisting":"Clona un wiki existent",
	"Toolbar/NoWikisToClone":"No hi ha cap wiki disponible per clonar","Toolbar/Help":"Ajuda","Toolbar/Settings":"Configuració","Toolbar/Language":"Idioma",
	"List/SearchPlaceholder":"cerca","List/ClearSearch":"Esborra la cerca",
	"Row/Untitled":"Sense títol","Row/Open":"obre","Row/Reveal":"mostra","Row/Remove":"elimina","Row/ToFolder":"a carpeta","Row/ToFile":"a fitxer",
	"Row/ToFolderTooltip":"Trieu (o creeu) una carpeta buida per a la nova carpeta wiki","Row/ToFileTooltip":"Trieu on desar el nou wiki de fitxer únic",
	"Row/Advanced":"avançat","Row/Plugins":"connectors",
	"Advanced/Backups":"Còpies de seguretat","Advanced/SaveBackup":"Desa una còpia de seguretat a cada desada","Advanced/RevealBackups":"mostra les còpies de seguretat",
	"Advanced/ServerNote":"Aquestes opcions controlen com es serveix la carpeta wiki per HTTP. Tenen efecte la propera vegada que s’obri la carpeta wiki.",
	"Advanced/Server":"Servidor","Advanced/Host":"Amfitrió","Advanced/Port":"Port","Advanced/PathPrefix":"Prefix de camí","Advanced/RootTiddler":"Tiddler arrel",
	"Advanced/Gzip":"Comprimeix les respostes (gzip)","Advanced/Access":"Accés","Advanced/Credentials":"Fitxer de credencials","Advanced/AnonUsername":"Nom d’usuari anònim",
	"Advanced/Readers":"Lectors","Advanced/Writers":"Escriptors",
	"PluginChooser/Heading":"Gestiona els connectors","PluginChooser/Close":"Tanca","PluginChooser/OpenWarning":"Aquest wiki està obert actualment. Tanqueu-ne primer la finestra i després feu clic a Aplica.",
	"PluginChooser/FilterPlaceholder":"Filtra els connectors…","PluginChooser/Clear":"Esborra","PluginChooser/NoMatch":"Cap connector coincideix amb el filtre.","PluginChooser/Apply":"Aplica els canvis","PluginChooser/Cancel":"Cancel·la"
};

T["it-IT"] = {
	_empty: "Aggiungi un file o una cartella ~TiddlyWiki per iniziare.\n\nFai clic sui pulsanti qui sopra per sfogliare, oppure trascina e rilascia dal tuo Esplora file/Finder.",
	"Toolbar/AddWikiFile":"Aggiungi file wiki","Toolbar/AddWikiFolder":"Aggiungi cartella wiki","Toolbar/Backstage":"Backstage",
	"Toolbar/CreateWikiFolder":"Crea nuova cartella wiki","Toolbar/CreateWiki":"Crea nuovo wiki","Toolbar/CreateFromTemplate":"Crea da un modello",
	"Toolbar/NoTemplates":"Nessun modello definito – vedi Impostazioni","Toolbar/From":"da","Toolbar/CloneExisting":"Clona un wiki esistente",
	"Toolbar/NoWikisToClone":"Nessun wiki disponibile da clonare","Toolbar/Help":"Aiuto","Toolbar/Settings":"Impostazioni","Toolbar/Language":"Lingua",
	"List/SearchPlaceholder":"cerca","List/ClearSearch":"Cancella ricerca",
	"Row/Untitled":"Senza titolo","Row/Open":"apri","Row/Reveal":"mostra","Row/Remove":"rimuovi","Row/ToFolder":"in cartella","Row/ToFile":"in file",
	"Row/ToFolderTooltip":"Scegli (o crea) una cartella vuota per la nuova cartella wiki","Row/ToFileTooltip":"Scegli dove salvare il nuovo wiki in file singolo",
	"Row/Advanced":"avanzate","Row/Plugins":"plugin",
	"Advanced/Backups":"Backup","Advanced/SaveBackup":"Salva un backup a ogni salvataggio","Advanced/RevealBackups":"mostra i backup",
	"Advanced/ServerNote":"Queste opzioni controllano come la cartella wiki viene servita via HTTP. Hanno effetto alla prossima apertura della cartella wiki.",
	"Advanced/Server":"Server","Advanced/Host":"Host","Advanced/Port":"Porta","Advanced/PathPrefix":"Prefisso percorso","Advanced/RootTiddler":"Tiddler radice",
	"Advanced/Gzip":"Comprimi le risposte (gzip)","Advanced/Access":"Accesso","Advanced/Credentials":"File delle credenziali","Advanced/AnonUsername":"Nome utente anonimo",
	"Advanced/Readers":"Lettori","Advanced/Writers":"Scrittori",
	"PluginChooser/Heading":"Gestisci plugin","PluginChooser/Close":"Chiudi","PluginChooser/OpenWarning":"Questo wiki è attualmente aperto. Chiudi prima la sua finestra, poi fai clic su Applica.",
	"PluginChooser/FilterPlaceholder":"Filtra plugin…","PluginChooser/Clear":"Cancella","PluginChooser/NoMatch":"Nessun plugin corrisponde al filtro.","PluginChooser/Apply":"Applica modifiche","PluginChooser/Cancel":"Annulla"
};

T["pt-BR"] = {
	_empty: "Adicione um arquivo ou uma pasta do ~TiddlyWiki para começar.\n\nClique nos botões acima para navegar, ou arraste e solte do seu Explorador de Arquivos/Finder.",
	"Toolbar/AddWikiFile":"Adicionar arquivo wiki","Toolbar/AddWikiFolder":"Adicionar pasta wiki","Toolbar/Backstage":"Bastidores",
	"Toolbar/CreateWikiFolder":"Criar nova pasta wiki","Toolbar/CreateWiki":"Criar novo wiki","Toolbar/CreateFromTemplate":"Criar a partir de um modelo",
	"Toolbar/NoTemplates":"Nenhum modelo definido — veja Configurações","Toolbar/From":"de","Toolbar/CloneExisting":"Clonar um wiki existente",
	"Toolbar/NoWikisToClone":"Nenhum wiki disponível para clonar","Toolbar/Help":"Ajuda","Toolbar/Settings":"Configurações","Toolbar/Language":"Idioma",
	"List/SearchPlaceholder":"pesquisar","List/ClearSearch":"Limpar pesquisa",
	"Row/Untitled":"Sem título","Row/Open":"abrir","Row/Reveal":"revelar","Row/Remove":"remover","Row/ToFolder":"para pasta","Row/ToFile":"para arquivo",
	"Row/ToFolderTooltip":"Escolha (ou crie) uma pasta vazia para a nova pasta wiki","Row/ToFileTooltip":"Escolha onde salvar o novo wiki de arquivo único",
	"Row/Advanced":"avançado","Row/Plugins":"plugins",
	"Advanced/Backups":"Backups","Advanced/SaveBackup":"Salvar um backup a cada gravação","Advanced/RevealBackups":"revelar backups",
	"Advanced/ServerNote":"Estas opções controlam como a pasta wiki é servida por HTTP. Elas entram em vigor na próxima vez que a pasta wiki for aberta.",
	"Advanced/Server":"Servidor","Advanced/Host":"Host","Advanced/Port":"Porta","Advanced/PathPrefix":"Prefixo de caminho","Advanced/RootTiddler":"Tiddler raiz",
	"Advanced/Gzip":"Comprimir respostas (gzip)","Advanced/Access":"Acesso","Advanced/Credentials":"Arquivo de credenciais","Advanced/AnonUsername":"Nome de usuário anônimo",
	"Advanced/Readers":"Leitores","Advanced/Writers":"Escritores",
	"PluginChooser/Heading":"Gerenciar plugins","PluginChooser/Close":"Fechar","PluginChooser/OpenWarning":"Este wiki está aberto no momento. Feche a janela dele primeiro e depois clique em Aplicar.",
	"PluginChooser/FilterPlaceholder":"Filtrar plugins…","PluginChooser/Clear":"Limpar","PluginChooser/NoMatch":"Nenhum plugin corresponde ao seu filtro.","PluginChooser/Apply":"Aplicar alterações","PluginChooser/Cancel":"Cancelar"
};

T["pt-PT"] = {
	_empty: "Adicione um ficheiro ou uma pasta do ~TiddlyWiki para começar.\n\nClique nos botões acima para navegar, ou arraste e largue a partir do seu Explorador de Ficheiros/Finder.",
	"Toolbar/AddWikiFile":"Adicionar ficheiro wiki","Toolbar/AddWikiFolder":"Adicionar pasta wiki","Toolbar/Backstage":"Bastidores",
	"Toolbar/CreateWikiFolder":"Criar nova pasta wiki","Toolbar/CreateWiki":"Criar novo wiki","Toolbar/CreateFromTemplate":"Criar a partir de um modelo",
	"Toolbar/NoTemplates":"Nenhum modelo definido — ver Definições","Toolbar/From":"de","Toolbar/CloneExisting":"Clonar um wiki existente",
	"Toolbar/NoWikisToClone":"Nenhum wiki disponível para clonar","Toolbar/Help":"Ajuda","Toolbar/Settings":"Definições","Toolbar/Language":"Idioma",
	"List/SearchPlaceholder":"pesquisar","List/ClearSearch":"Limpar pesquisa",
	"Row/Untitled":"Sem título","Row/Open":"abrir","Row/Reveal":"revelar","Row/Remove":"remover","Row/ToFolder":"para pasta","Row/ToFile":"para ficheiro",
	"Row/ToFolderTooltip":"Escolha (ou crie) uma pasta vazia para a nova pasta wiki","Row/ToFileTooltip":"Escolha onde guardar o novo wiki de ficheiro único",
	"Row/Advanced":"avançado","Row/Plugins":"plugins",
	"Advanced/Backups":"Cópias de segurança","Advanced/SaveBackup":"Guardar uma cópia de segurança em cada gravação","Advanced/RevealBackups":"revelar cópias de segurança",
	"Advanced/ServerNote":"Estas opções controlam como a pasta wiki é servida por HTTP. Entram em vigor da próxima vez que a pasta wiki for aberta.",
	"Advanced/Server":"Servidor","Advanced/Host":"Anfitrião","Advanced/Port":"Porta","Advanced/PathPrefix":"Prefixo de caminho","Advanced/RootTiddler":"Tiddler raiz",
	"Advanced/Gzip":"Comprimir respostas (gzip)","Advanced/Access":"Acesso","Advanced/Credentials":"Ficheiro de credenciais","Advanced/AnonUsername":"Nome de utilizador anónimo",
	"Advanced/Readers":"Leitores","Advanced/Writers":"Escritores",
	"PluginChooser/Heading":"Gerir plugins","PluginChooser/Close":"Fechar","PluginChooser/OpenWarning":"Este wiki está aberto neste momento. Feche primeiro a respetiva janela e depois clique em Aplicar.",
	"PluginChooser/FilterPlaceholder":"Filtrar plugins…","PluginChooser/Clear":"Limpar","PluginChooser/NoMatch":"Nenhum plugin corresponde ao seu filtro.","PluginChooser/Apply":"Aplicar alterações","PluginChooser/Cancel":"Cancelar"
};

T["nl-NL"] = {
	_empty: "Voeg een ~TiddlyWiki-bestand of -map toe om te beginnen.\n\nKlik op de knoppen hierboven om te bladeren, of sleep bestanden vanuit je Verkenner/Finder.",
	"Toolbar/AddWikiFile":"Wiki-bestand toevoegen","Toolbar/AddWikiFolder":"Wiki-map toevoegen","Toolbar/Backstage":"Backstage",
	"Toolbar/CreateWikiFolder":"Nieuwe wiki-map maken","Toolbar/CreateWiki":"Nieuwe wiki maken","Toolbar/CreateFromTemplate":"Maken op basis van een sjabloon",
	"Toolbar/NoTemplates":"Geen sjablonen gedefinieerd – zie Instellingen","Toolbar/From":"uit","Toolbar/CloneExisting":"Een bestaande wiki klonen",
	"Toolbar/NoWikisToClone":"Geen wiki's beschikbaar om te klonen","Toolbar/Help":"Help","Toolbar/Settings":"Instellingen","Toolbar/Language":"Taal",
	"List/SearchPlaceholder":"zoeken","List/ClearSearch":"Zoekopdracht wissen",
	"Row/Untitled":"Naamloos","Row/Open":"openen","Row/Reveal":"tonen","Row/Remove":"verwijderen","Row/ToFolder":"naar map","Row/ToFile":"naar bestand",
	"Row/ToFolderTooltip":"Kies (of maak) een lege map voor de nieuwe wiki-map","Row/ToFileTooltip":"Kies waar de nieuwe enkelbestands-wiki moet worden opgeslagen",
	"Row/Advanced":"geavanceerd","Row/Plugins":"plug-ins",
	"Advanced/Backups":"Back-ups","Advanced/SaveBackup":"Een back-up maken bij elke keer opslaan","Advanced/RevealBackups":"back-ups tonen",
	"Advanced/ServerNote":"Deze opties bepalen hoe de wiki-map via HTTP wordt aangeboden. Ze worden van kracht de volgende keer dat de wiki-map wordt geopend.",
	"Advanced/Server":"Server","Advanced/Host":"Host","Advanced/Port":"Poort","Advanced/PathPrefix":"Padvoorvoegsel","Advanced/RootTiddler":"Root-tiddler",
	"Advanced/Gzip":"Antwoorden comprimeren (gzip)","Advanced/Access":"Toegang","Advanced/Credentials":"Inloggegevensbestand","Advanced/AnonUsername":"Anonieme gebruikersnaam",
	"Advanced/Readers":"Lezers","Advanced/Writers":"Schrijvers",
	"PluginChooser/Heading":"Plug-ins beheren","PluginChooser/Close":"Sluiten","PluginChooser/OpenWarning":"Deze wiki is momenteel geopend. Sluit eerst het venster en klik daarna op Toepassen.",
	"PluginChooser/FilterPlaceholder":"Plug-ins filteren…","PluginChooser/Clear":"Wissen","PluginChooser/NoMatch":"Geen plug-ins komen overeen met je filter.","PluginChooser/Apply":"Wijzigingen toepassen","PluginChooser/Cancel":"Annuleren"
};

T["da-DK"] = {
	_empty: "Tilføj en ~TiddlyWiki-fil eller -mappe for at komme i gang.\n\nKlik på knapperne ovenfor for at gennemse, eller træk og slip fra din Stifinder/Finder.",
	"Toolbar/AddWikiFile":"Tilføj wiki-fil","Toolbar/AddWikiFolder":"Tilføj wiki-mappe","Toolbar/Backstage":"Backstage",
	"Toolbar/CreateWikiFolder":"Opret ny wiki-mappe","Toolbar/CreateWiki":"Opret ny wiki","Toolbar/CreateFromTemplate":"Opret ud fra en skabelon",
	"Toolbar/NoTemplates":"Ingen skabeloner defineret – se Indstillinger","Toolbar/From":"fra","Toolbar/CloneExisting":"Klon en eksisterende wiki",
	"Toolbar/NoWikisToClone":"Ingen wikier tilgængelige at klone","Toolbar/Help":"Hjælp","Toolbar/Settings":"Indstillinger","Toolbar/Language":"Sprog",
	"List/SearchPlaceholder":"søg","List/ClearSearch":"Ryd søgning",
	"Row/Untitled":"Uden titel","Row/Open":"åbn","Row/Reveal":"vis","Row/Remove":"fjern","Row/ToFolder":"til mappe","Row/ToFile":"til fil",
	"Row/ToFolderTooltip":"Vælg (eller opret) en tom mappe til den nye wiki-mappe","Row/ToFileTooltip":"Vælg, hvor den nye enkeltfils-wiki skal gemmes",
	"Row/Advanced":"avanceret","Row/Plugins":"plugins",
	"Advanced/Backups":"Sikkerhedskopier","Advanced/SaveBackup":"Gem en sikkerhedskopi ved hver lagring","Advanced/RevealBackups":"vis sikkerhedskopier",
	"Advanced/ServerNote":"Disse indstillinger styrer, hvordan wiki-mappen serveres over HTTP. De træder i kraft, næste gang wiki-mappen åbnes.",
	"Advanced/Server":"Server","Advanced/Host":"Vært","Advanced/Port":"Port","Advanced/PathPrefix":"Sti-præfiks","Advanced/RootTiddler":"Rod-tiddler",
	"Advanced/Gzip":"Komprimér svar (gzip)","Advanced/Access":"Adgang","Advanced/Credentials":"Loginfil","Advanced/AnonUsername":"Anonymt brugernavn",
	"Advanced/Readers":"Læsere","Advanced/Writers":"Skribenter",
	"PluginChooser/Heading":"Administrer plugins","PluginChooser/Close":"Luk","PluginChooser/OpenWarning":"Denne wiki er åben i øjeblikket. Luk først dens vindue, og klik derefter på Anvend.",
	"PluginChooser/FilterPlaceholder":"Filtrér plugins…","PluginChooser/Clear":"Ryd","PluginChooser/NoMatch":"Ingen plugins matcher dit filter.","PluginChooser/Apply":"Anvend ændringer","PluginChooser/Cancel":"Annullér"
};

T["sv-SE"] = {
	_empty: "Lägg till en ~TiddlyWiki-fil eller -mapp för att komma igång.\n\nKlicka på knapparna ovan för att bläddra, eller dra och släpp från din Utforskaren/Finder.",
	"Toolbar/AddWikiFile":"Lägg till wiki-fil","Toolbar/AddWikiFolder":"Lägg till wiki-mapp","Toolbar/Backstage":"Backstage",
	"Toolbar/CreateWikiFolder":"Skapa ny wiki-mapp","Toolbar/CreateWiki":"Skapa ny wiki","Toolbar/CreateFromTemplate":"Skapa från en mall",
	"Toolbar/NoTemplates":"Inga mallar definierade – se Inställningar","Toolbar/From":"från","Toolbar/CloneExisting":"Klona en befintlig wiki",
	"Toolbar/NoWikisToClone":"Inga wikier tillgängliga att klona","Toolbar/Help":"Hjälp","Toolbar/Settings":"Inställningar","Toolbar/Language":"Språk",
	"List/SearchPlaceholder":"sök","List/ClearSearch":"Rensa sökning",
	"Row/Untitled":"Namnlös","Row/Open":"öppna","Row/Reveal":"visa","Row/Remove":"ta bort","Row/ToFolder":"till mapp","Row/ToFile":"till fil",
	"Row/ToFolderTooltip":"Välj (eller skapa) en tom mapp för den nya wiki-mappen","Row/ToFileTooltip":"Välj var den nya enkelfils-wikin ska sparas",
	"Row/Advanced":"avancerat","Row/Plugins":"tillägg",
	"Advanced/Backups":"Säkerhetskopior","Advanced/SaveBackup":"Spara en säkerhetskopia vid varje sparning","Advanced/RevealBackups":"visa säkerhetskopior",
	"Advanced/ServerNote":"Dessa alternativ styr hur wiki-mappen serveras över HTTP. De träder i kraft nästa gång wiki-mappen öppnas.",
	"Advanced/Server":"Server","Advanced/Host":"Värd","Advanced/Port":"Port","Advanced/PathPrefix":"Sökvägsprefix","Advanced/RootTiddler":"Rot-tiddler",
	"Advanced/Gzip":"Komprimera svar (gzip)","Advanced/Access":"Åtkomst","Advanced/Credentials":"Autentiseringsfil","Advanced/AnonUsername":"Anonymt användarnamn",
	"Advanced/Readers":"Läsare","Advanced/Writers":"Skribenter",
	"PluginChooser/Heading":"Hantera tillägg","PluginChooser/Close":"Stäng","PluginChooser/OpenWarning":"Den här wikin är öppen just nu. Stäng först dess fönster och klicka sedan på Tillämpa.",
	"PluginChooser/FilterPlaceholder":"Filtrera tillägg…","PluginChooser/Clear":"Rensa","PluginChooser/NoMatch":"Inga tillägg matchar ditt filter.","PluginChooser/Apply":"Tillämpa ändringar","PluginChooser/Cancel":"Avbryt"
};

T["pl-PL"] = {
	_empty: "Dodaj plik lub folder ~TiddlyWiki, aby rozpocząć.\n\nKliknij przyciski powyżej, aby przeglądać, lub przeciągnij i upuść z Eksploratora plików/Findera.",
	"Toolbar/AddWikiFile":"Dodaj plik wiki","Toolbar/AddWikiFolder":"Dodaj folder wiki","Toolbar/Backstage":"Zaplecze",
	"Toolbar/CreateWikiFolder":"Utwórz nowy folder wiki","Toolbar/CreateWiki":"Utwórz nowe wiki","Toolbar/CreateFromTemplate":"Utwórz z szablonu",
	"Toolbar/NoTemplates":"Nie zdefiniowano szablonów – zobacz Ustawienia","Toolbar/From":"z","Toolbar/CloneExisting":"Sklonuj istniejące wiki",
	"Toolbar/NoWikisToClone":"Brak wiki do sklonowania","Toolbar/Help":"Pomoc","Toolbar/Settings":"Ustawienia","Toolbar/Language":"Język",
	"List/SearchPlaceholder":"szukaj","List/ClearSearch":"Wyczyść wyszukiwanie",
	"Row/Untitled":"Bez tytułu","Row/Open":"otwórz","Row/Reveal":"pokaż","Row/Remove":"usuń","Row/ToFolder":"do folderu","Row/ToFile":"do pliku",
	"Row/ToFolderTooltip":"Wybierz (lub utwórz) pusty folder dla nowego folderu wiki","Row/ToFileTooltip":"Wybierz, gdzie zapisać nowe wiki jednoplikowe",
	"Row/Advanced":"zaawansowane","Row/Plugins":"wtyczki",
	"Advanced/Backups":"Kopie zapasowe","Advanced/SaveBackup":"Zapisuj kopię zapasową przy każdym zapisie","Advanced/RevealBackups":"pokaż kopie zapasowe",
	"Advanced/ServerNote":"Te opcje określają, jak folder wiki jest udostępniany przez HTTP. Zaczynają obowiązywać przy następnym otwarciu folderu wiki.",
	"Advanced/Server":"Serwer","Advanced/Host":"Host","Advanced/Port":"Port","Advanced/PathPrefix":"Prefiks ścieżki","Advanced/RootTiddler":"Tiddler główny",
	"Advanced/Gzip":"Kompresuj odpowiedzi (gzip)","Advanced/Access":"Dostęp","Advanced/Credentials":"Plik poświadczeń","Advanced/AnonUsername":"Anonimowa nazwa użytkownika",
	"Advanced/Readers":"Czytelnicy","Advanced/Writers":"Piszący",
	"PluginChooser/Heading":"Zarządzaj wtyczkami","PluginChooser/Close":"Zamknij","PluginChooser/OpenWarning":"To wiki jest obecnie otwarte. Najpierw zamknij jego okno, a następnie kliknij Zastosuj.",
	"PluginChooser/FilterPlaceholder":"Filtruj wtyczki…","PluginChooser/Clear":"Wyczyść","PluginChooser/NoMatch":"Żadna wtyczka nie pasuje do filtra.","PluginChooser/Apply":"Zastosuj zmiany","PluginChooser/Cancel":"Anuluj"
};

T["cs-CZ"] = {
	_empty: "Začněte přidáním souboru nebo složky ~TiddlyWiki.\n\nKlikněte na tlačítka výše pro procházení, nebo přetáhněte soubory z Průzkumníka/Finderu.",
	"Toolbar/AddWikiFile":"Přidat soubor wiki","Toolbar/AddWikiFolder":"Přidat složku wiki","Toolbar/Backstage":"Zákulisí",
	"Toolbar/CreateWikiFolder":"Vytvořit novou složku wiki","Toolbar/CreateWiki":"Vytvořit nové wiki","Toolbar/CreateFromTemplate":"Vytvořit ze šablony",
	"Toolbar/NoTemplates":"Nejsou definovány žádné šablony – viz Nastavení","Toolbar/From":"z","Toolbar/CloneExisting":"Klonovat existující wiki",
	"Toolbar/NoWikisToClone":"Žádná wiki k klonování","Toolbar/Help":"Nápověda","Toolbar/Settings":"Nastavení","Toolbar/Language":"Jazyk",
	"List/SearchPlaceholder":"hledat","List/ClearSearch":"Vymazat hledání",
	"Row/Untitled":"Bez názvu","Row/Open":"otevřít","Row/Reveal":"zobrazit","Row/Remove":"odebrat","Row/ToFolder":"do složky","Row/ToFile":"do souboru",
	"Row/ToFolderTooltip":"Vyberte (nebo vytvořte) prázdnou složku pro novou složku wiki","Row/ToFileTooltip":"Vyberte, kam uložit nové jednosouborové wiki",
	"Row/Advanced":"pokročilé","Row/Plugins":"pluginy",
	"Advanced/Backups":"Zálohy","Advanced/SaveBackup":"Uložit zálohu při každém uložení","Advanced/RevealBackups":"zobrazit zálohy",
	"Advanced/ServerNote":"Tyto možnosti řídí, jak je složka wiki poskytována přes HTTP. Projeví se při příštím otevření složky wiki.",
	"Advanced/Server":"Server","Advanced/Host":"Hostitel","Advanced/Port":"Port","Advanced/PathPrefix":"Předpona cesty","Advanced/RootTiddler":"Kořenový tiddler",
	"Advanced/Gzip":"Komprimovat odpovědi (gzip)","Advanced/Access":"Přístup","Advanced/Credentials":"Soubor s přihlašovacími údaji","Advanced/AnonUsername":"Anonymní uživatelské jméno",
	"Advanced/Readers":"Čtenáři","Advanced/Writers":"Zapisovatelé",
	"PluginChooser/Heading":"Spravovat pluginy","PluginChooser/Close":"Zavřít","PluginChooser/OpenWarning":"Toto wiki je momentálně otevřené. Nejprve zavřete jeho okno a poté klikněte na Použít.",
	"PluginChooser/FilterPlaceholder":"Filtrovat pluginy…","PluginChooser/Clear":"Vymazat","PluginChooser/NoMatch":"Filtru neodpovídají žádné pluginy.","PluginChooser/Apply":"Použít změny","PluginChooser/Cancel":"Zrušit"
};

T["sk-SK"] = {
	_empty: "Začnite pridaním súboru alebo priečinka ~TiddlyWiki.\n\nKliknite na tlačidlá vyššie na prehliadanie, alebo presuňte súbory z Prieskumníka/Finderu.",
	"Toolbar/AddWikiFile":"Pridať súbor wiki","Toolbar/AddWikiFolder":"Pridať priečinok wiki","Toolbar/Backstage":"Zákulisie",
	"Toolbar/CreateWikiFolder":"Vytvoriť nový priečinok wiki","Toolbar/CreateWiki":"Vytvoriť nové wiki","Toolbar/CreateFromTemplate":"Vytvoriť zo šablóny",
	"Toolbar/NoTemplates":"Nie sú definované žiadne šablóny – pozri Nastavenia","Toolbar/From":"z","Toolbar/CloneExisting":"Klonovať existujúce wiki",
	"Toolbar/NoWikisToClone":"Žiadne wiki na klonovanie","Toolbar/Help":"Pomocník","Toolbar/Settings":"Nastavenia","Toolbar/Language":"Jazyk",
	"List/SearchPlaceholder":"hľadať","List/ClearSearch":"Vymazať hľadanie",
	"Row/Untitled":"Bez názvu","Row/Open":"otvoriť","Row/Reveal":"zobraziť","Row/Remove":"odstrániť","Row/ToFolder":"do priečinka","Row/ToFile":"do súboru",
	"Row/ToFolderTooltip":"Vyberte (alebo vytvorte) prázdny priečinok pre nový priečinok wiki","Row/ToFileTooltip":"Vyberte, kam uložiť nové jednosúborové wiki",
	"Row/Advanced":"pokročilé","Row/Plugins":"pluginy",
	"Advanced/Backups":"Zálohy","Advanced/SaveBackup":"Uložiť zálohu pri každom uložení","Advanced/RevealBackups":"zobraziť zálohy",
	"Advanced/ServerNote":"Tieto možnosti riadia, ako sa priečinok wiki poskytuje cez HTTP. Prejavia sa pri ďalšom otvorení priečinka wiki.",
	"Advanced/Server":"Server","Advanced/Host":"Hostiteľ","Advanced/Port":"Port","Advanced/PathPrefix":"Predpona cesty","Advanced/RootTiddler":"Koreňový tiddler",
	"Advanced/Gzip":"Komprimovať odpovede (gzip)","Advanced/Access":"Prístup","Advanced/Credentials":"Súbor s prihlasovacími údajmi","Advanced/AnonUsername":"Anonymné používateľské meno",
	"Advanced/Readers":"Čitatelia","Advanced/Writers":"Zapisovatelia",
	"PluginChooser/Heading":"Spravovať pluginy","PluginChooser/Close":"Zavrieť","PluginChooser/OpenWarning":"Toto wiki je momentálne otvorené. Najprv zatvorte jeho okno a potom kliknite na Použiť.",
	"PluginChooser/FilterPlaceholder":"Filtrovať pluginy…","PluginChooser/Clear":"Vymazať","PluginChooser/NoMatch":"Filtru nezodpovedajú žiadne pluginy.","PluginChooser/Apply":"Použiť zmeny","PluginChooser/Cancel":"Zrušiť"
};

T["sl-SI"] = {
	_empty: "Za začetek dodajte datoteko ali mapo ~TiddlyWiki.\n\nKliknite gumbe zgoraj za brskanje ali povlecite in spustite iz Raziskovalca/Finderja.",
	"Toolbar/AddWikiFile":"Dodaj datoteko wiki","Toolbar/AddWikiFolder":"Dodaj mapo wiki","Toolbar/Backstage":"Zakulisje",
	"Toolbar/CreateWikiFolder":"Ustvari novo mapo wiki","Toolbar/CreateWiki":"Ustvari novi wiki","Toolbar/CreateFromTemplate":"Ustvari iz predloge",
	"Toolbar/NoTemplates":"Ni opredeljenih predlog – glejte Nastavitve","Toolbar/From":"iz","Toolbar/CloneExisting":"Kloniraj obstoječi wiki",
	"Toolbar/NoWikisToClone":"Na voljo ni nobenega wikija za kloniranje","Toolbar/Help":"Pomoč","Toolbar/Settings":"Nastavitve","Toolbar/Language":"Jezik",
	"List/SearchPlaceholder":"iskanje","List/ClearSearch":"Počisti iskanje",
	"Row/Untitled":"Brez naslova","Row/Open":"odpri","Row/Reveal":"prikaži","Row/Remove":"odstrani","Row/ToFolder":"v mapo","Row/ToFile":"v datoteko",
	"Row/ToFolderTooltip":"Izberite (ali ustvarite) prazno mapo za novo mapo wiki","Row/ToFileTooltip":"Izberite, kam shraniti novi enodatotečni wiki",
	"Row/Advanced":"napredno","Row/Plugins":"vtičniki",
	"Advanced/Backups":"Varnostne kopije","Advanced/SaveBackup":"Shrani varnostno kopijo ob vsakem shranjevanju","Advanced/RevealBackups":"prikaži varnostne kopije",
	"Advanced/ServerNote":"Te možnosti določajo, kako se mapa wiki streže prek HTTP. Začnejo veljati ob naslednjem odpiranju mape wiki.",
	"Advanced/Server":"Strežnik","Advanced/Host":"Gostitelj","Advanced/Port":"Vrata","Advanced/PathPrefix":"Predpona poti","Advanced/RootTiddler":"Korenski tiddler",
	"Advanced/Gzip":"Stisni odgovore (gzip)","Advanced/Access":"Dostop","Advanced/Credentials":"Datoteka s poverilnicami","Advanced/AnonUsername":"Anonimno uporabniško ime",
	"Advanced/Readers":"Bralci","Advanced/Writers":"Pisci",
	"PluginChooser/Heading":"Upravljanje vtičnikov","PluginChooser/Close":"Zapri","PluginChooser/OpenWarning":"Ta wiki je trenutno odprt. Najprej zaprite njegovo okno in nato kliknite Uporabi.",
	"PluginChooser/FilterPlaceholder":"Filtriraj vtičnike…","PluginChooser/Clear":"Počisti","PluginChooser/NoMatch":"Filtru ne ustreza noben vtičnik.","PluginChooser/Apply":"Uporabi spremembe","PluginChooser/Cancel":"Prekliči"
};

T["mk-MK"] = {
	_empty: "Додајте датотека или папка на ~TiddlyWiki за да започнете.\n\nКликнете на копчињата погоре за прелистување или повлечете и пуштете од вашиот Истражувач/Finder.",
	"Toolbar/AddWikiFile":"Додај вики-датотека","Toolbar/AddWikiFolder":"Додај вики-папка","Toolbar/Backstage":"Зад сцената",
	"Toolbar/CreateWikiFolder":"Создај нова вики-папка","Toolbar/CreateWiki":"Создај ново вики","Toolbar/CreateFromTemplate":"Создај од урнек",
	"Toolbar/NoTemplates":"Нема дефинирани урнеци – видете Поставки","Toolbar/From":"од","Toolbar/CloneExisting":"Клонирај постоечко вики",
	"Toolbar/NoWikisToClone":"Нема вики достапни за клонирање","Toolbar/Help":"Помош","Toolbar/Settings":"Поставки","Toolbar/Language":"Јазик",
	"List/SearchPlaceholder":"барај","List/ClearSearch":"Исчисти го барањето",
	"Row/Untitled":"Без наслов","Row/Open":"отвори","Row/Reveal":"прикажи","Row/Remove":"отстрани","Row/ToFolder":"во папка","Row/ToFile":"во датотека",
	"Row/ToFolderTooltip":"Изберете (или создадете) празна папка за новата вики-папка","Row/ToFileTooltip":"Изберете каде да се зачува новото вики во една датотека",
	"Row/Advanced":"напредно","Row/Plugins":"приклучоци",
	"Advanced/Backups":"Резервни копии","Advanced/SaveBackup":"Зачувај резервна копија при секое зачувување","Advanced/RevealBackups":"прикажи резервни копии",
	"Advanced/ServerNote":"Овие опции контролираат како вики-папката се служи преку HTTP. Стапуваат во сила следниот пат кога ќе се отвори вики-папката.",
	"Advanced/Server":"Сервер","Advanced/Host":"Домаќин","Advanced/Port":"Порта","Advanced/PathPrefix":"Префикс на патека","Advanced/RootTiddler":"Корен tiddler",
	"Advanced/Gzip":"Компресирај одговори (gzip)","Advanced/Access":"Пристап","Advanced/Credentials":"Датотека со акредитиви","Advanced/AnonUsername":"Анонимно корисничко име",
	"Advanced/Readers":"Читатели","Advanced/Writers":"Запишувачи",
	"PluginChooser/Heading":"Управувај со приклучоци","PluginChooser/Close":"Затвори","PluginChooser/OpenWarning":"Ова вики е моментално отворено. Прво затворете го неговиот прозорец, а потоа кликнете Примени.",
	"PluginChooser/FilterPlaceholder":"Филтрирај приклучоци…","PluginChooser/Clear":"Исчисти","PluginChooser/NoMatch":"Ниту еден приклучок не одговара на вашиот филтер.","PluginChooser/Apply":"Примени измени","PluginChooser/Cancel":"Откажи"
};

T["ru-RU"] = {
	_empty: "Добавьте файл или папку ~TiddlyWiki, чтобы начать.\n\nНажмите кнопки выше для обзора или перетащите файлы из Проводника/Finder.",
	"Toolbar/AddWikiFile":"Добавить файл вики","Toolbar/AddWikiFolder":"Добавить папку вики","Toolbar/Backstage":"Закулисье",
	"Toolbar/CreateWikiFolder":"Создать новую папку вики","Toolbar/CreateWiki":"Создать новую вики","Toolbar/CreateFromTemplate":"Создать из шаблона",
	"Toolbar/NoTemplates":"Шаблоны не заданы — см. Настройки","Toolbar/From":"из","Toolbar/CloneExisting":"Клонировать существующую вики",
	"Toolbar/NoWikisToClone":"Нет вики для клонирования","Toolbar/Help":"Справка","Toolbar/Settings":"Настройки","Toolbar/Language":"Язык",
	"List/SearchPlaceholder":"поиск","List/ClearSearch":"Очистить поиск",
	"Row/Untitled":"Без названия","Row/Open":"открыть","Row/Reveal":"показать","Row/Remove":"удалить","Row/ToFolder":"в папку","Row/ToFile":"в файл",
	"Row/ToFolderTooltip":"Выберите (или создайте) пустую папку для новой папки вики","Row/ToFileTooltip":"Выберите, куда сохранить новую вики в одном файле",
	"Row/Advanced":"дополнительно","Row/Plugins":"плагины",
	"Advanced/Backups":"Резервные копии","Advanced/SaveBackup":"Сохранять резервную копию при каждом сохранении","Advanced/RevealBackups":"показать резервные копии",
	"Advanced/ServerNote":"Эти параметры определяют, как папка вики раздаётся по HTTP. Они вступают в силу при следующем открытии папки вики.",
	"Advanced/Server":"Сервер","Advanced/Host":"Хост","Advanced/Port":"Порт","Advanced/PathPrefix":"Префикс пути","Advanced/RootTiddler":"Корневой tiddler",
	"Advanced/Gzip":"Сжимать ответы (gzip)","Advanced/Access":"Доступ","Advanced/Credentials":"Файл учётных данных","Advanced/AnonUsername":"Анонимное имя пользователя",
	"Advanced/Readers":"Читатели","Advanced/Writers":"Авторы",
	"PluginChooser/Heading":"Управление плагинами","PluginChooser/Close":"Закрыть","PluginChooser/OpenWarning":"Эта вики сейчас открыта. Сначала закройте её окно, затем нажмите Применить.",
	"PluginChooser/FilterPlaceholder":"Фильтр плагинов…","PluginChooser/Clear":"Очистить","PluginChooser/NoMatch":"Нет плагинов, соответствующих фильтру.","PluginChooser/Apply":"Применить изменения","PluginChooser/Cancel":"Отмена"
};

T["el-GR"] = {
	_empty: "Προσθέστε ένα αρχείο ή φάκελο ~TiddlyWiki για να ξεκινήσετε.\n\nΚάντε κλικ στα κουμπιά παραπάνω για περιήγηση ή σύρετε και αποθέστε από την Εξερεύνηση αρχείων/Finder.",
	"Toolbar/AddWikiFile":"Προσθήκη αρχείου wiki","Toolbar/AddWikiFolder":"Προσθήκη φακέλου wiki","Toolbar/Backstage":"Παρασκήνιο",
	"Toolbar/CreateWikiFolder":"Δημιουργία νέου φακέλου wiki","Toolbar/CreateWiki":"Δημιουργία νέου wiki","Toolbar/CreateFromTemplate":"Δημιουργία από πρότυπο",
	"Toolbar/NoTemplates":"Δεν έχουν οριστεί πρότυπα – δείτε Ρυθμίσεις","Toolbar/From":"από","Toolbar/CloneExisting":"Κλωνοποίηση υπάρχοντος wiki",
	"Toolbar/NoWikisToClone":"Δεν υπάρχουν διαθέσιμα wiki για κλωνοποίηση","Toolbar/Help":"Βοήθεια","Toolbar/Settings":"Ρυθμίσεις","Toolbar/Language":"Γλώσσα",
	"List/SearchPlaceholder":"αναζήτηση","List/ClearSearch":"Καθαρισμός αναζήτησης",
	"Row/Untitled":"Χωρίς τίτλο","Row/Open":"άνοιγμα","Row/Reveal":"εμφάνιση","Row/Remove":"αφαίρεση","Row/ToFolder":"σε φάκελο","Row/ToFile":"σε αρχείο",
	"Row/ToFolderTooltip":"Επιλέξτε (ή δημιουργήστε) έναν κενό φάκελο για τον νέο φάκελο wiki","Row/ToFileTooltip":"Επιλέξτε πού θα αποθηκευτεί το νέο wiki ενός αρχείου",
	"Row/Advanced":"για προχωρημένους","Row/Plugins":"πρόσθετα",
	"Advanced/Backups":"Αντίγραφα ασφαλείας","Advanced/SaveBackup":"Αποθήκευση αντιγράφου ασφαλείας σε κάθε αποθήκευση","Advanced/RevealBackups":"εμφάνιση αντιγράφων ασφαλείας",
	"Advanced/ServerNote":"Αυτές οι επιλογές ελέγχουν πώς ο φάκελος wiki διανέμεται μέσω HTTP. Τίθενται σε ισχύ την επόμενη φορά που θα ανοίξει ο φάκελος wiki.",
	"Advanced/Server":"Διακομιστής","Advanced/Host":"Κεντρικός υπολογιστής","Advanced/Port":"Θύρα","Advanced/PathPrefix":"Πρόθεμα διαδρομής","Advanced/RootTiddler":"Ριζικό tiddler",
	"Advanced/Gzip":"Συμπίεση αποκρίσεων (gzip)","Advanced/Access":"Πρόσβαση","Advanced/Credentials":"Αρχείο διαπιστευτηρίων","Advanced/AnonUsername":"Ανώνυμο όνομα χρήστη",
	"Advanced/Readers":"Αναγνώστες","Advanced/Writers":"Συντάκτες",
	"PluginChooser/Heading":"Διαχείριση προσθέτων","PluginChooser/Close":"Κλείσιμο","PluginChooser/OpenWarning":"Αυτό το wiki είναι αυτή τη στιγμή ανοιχτό. Κλείστε πρώτα το παράθυρό του και μετά κάντε κλικ στο Εφαρμογή.",
	"PluginChooser/FilterPlaceholder":"Φιλτράρισμα προσθέτων…","PluginChooser/Clear":"Καθαρισμός","PluginChooser/NoMatch":"Κανένα πρόσθετο δεν ταιριάζει με το φίλτρο σας.","PluginChooser/Apply":"Εφαρμογή αλλαγών","PluginChooser/Cancel":"Άκυρο"
};

T["he-IL"] = {
	_empty: "הוסיפו קובץ או תיקייה של ~TiddlyWiki כדי להתחיל.\n\nלחצו על הכפתורים למעלה לעיון, או גררו ושחררו ממנהל הקבצים/Finder.",
	"Toolbar/AddWikiFile":"הוסף קובץ ויקי","Toolbar/AddWikiFolder":"הוסף תיקיית ויקי","Toolbar/Backstage":"מאחורי הקלעים",
	"Toolbar/CreateWikiFolder":"צור תיקיית ויקי חדשה","Toolbar/CreateWiki":"צור ויקי חדש","Toolbar/CreateFromTemplate":"צור מתבנית",
	"Toolbar/NoTemplates":"לא הוגדרו תבניות – ראו הגדרות","Toolbar/From":"מתוך","Toolbar/CloneExisting":"שכפל ויקי קיים",
	"Toolbar/NoWikisToClone":"אין ויקי זמין לשכפול","Toolbar/Help":"עזרה","Toolbar/Settings":"הגדרות","Toolbar/Language":"שפה",
	"List/SearchPlaceholder":"חיפוש","List/ClearSearch":"נקה חיפוש",
	"Row/Untitled":"ללא כותרת","Row/Open":"פתח","Row/Reveal":"הצג","Row/Remove":"הסר","Row/ToFolder":"לתיקייה","Row/ToFile":"לקובץ",
	"Row/ToFolderTooltip":"בחרו (או צרו) תיקייה ריקה עבור תיקיית הויקי החדשה","Row/ToFileTooltip":"בחרו היכן לשמור את הויקי החדש כקובץ יחיד",
	"Row/Advanced":"מתקדם","Row/Plugins":"תוספים",
	"Advanced/Backups":"גיבויים","Advanced/SaveBackup":"שמור גיבוי בכל שמירה","Advanced/RevealBackups":"הצג גיבויים",
	"Advanced/ServerNote":"אפשרויות אלה קובעות כיצד תיקיית הויקי מוגשת באמצעות HTTP. הן ייכנסו לתוקף בפעם הבאה שתיקיית הויקי תיפתח.",
	"Advanced/Server":"שרת","Advanced/Host":"מארח","Advanced/Port":"פורט","Advanced/PathPrefix":"קידומת נתיב","Advanced/RootTiddler":"טידלר שורש",
	"Advanced/Gzip":"דחוס תגובות (gzip)","Advanced/Access":"גישה","Advanced/Credentials":"קובץ אישורים","Advanced/AnonUsername":"שם משתמש אנונימי",
	"Advanced/Readers":"קוראים","Advanced/Writers":"כותבים",
	"PluginChooser/Heading":"ניהול תוספים","PluginChooser/Close":"סגור","PluginChooser/OpenWarning":"ויקי זה פתוח כעת. סגרו תחילה את חלונו ואז לחצו על החל.",
	"PluginChooser/FilterPlaceholder":"סנן תוספים…","PluginChooser/Clear":"נקה","PluginChooser/NoMatch":"אין תוספים התואמים את הסינון.","PluginChooser/Apply":"החל שינויים","PluginChooser/Cancel":"ביטול"
};

T["ar-PS"] = {
	_empty: "أضف ملف أو مجلد ~TiddlyWiki للبدء.\n\nانقر على الأزرار أعلاه للتصفح، أو اسحب وأفلت من مستكشف الملفات/Finder.",
	"Toolbar/AddWikiFile":"إضافة ملف ويكي","Toolbar/AddWikiFolder":"إضافة مجلد ويكي","Toolbar/Backstage":"الكواليس",
	"Toolbar/CreateWikiFolder":"إنشاء مجلد ويكي جديد","Toolbar/CreateWiki":"إنشاء ويكي جديد","Toolbar/CreateFromTemplate":"إنشاء من قالب",
	"Toolbar/NoTemplates":"لا توجد قوالب معرّفة – راجع الإعدادات","Toolbar/From":"من","Toolbar/CloneExisting":"استنساخ ويكي موجود",
	"Toolbar/NoWikisToClone":"لا توجد ويكي متاحة للاستنساخ","Toolbar/Help":"مساعدة","Toolbar/Settings":"الإعدادات","Toolbar/Language":"اللغة",
	"List/SearchPlaceholder":"بحث","List/ClearSearch":"مسح البحث",
	"Row/Untitled":"بدون عنوان","Row/Open":"فتح","Row/Reveal":"إظهار","Row/Remove":"إزالة","Row/ToFolder":"إلى مجلد","Row/ToFile":"إلى ملف",
	"Row/ToFolderTooltip":"اختر (أو أنشئ) مجلدًا فارغًا لمجلد الويكي الجديد","Row/ToFileTooltip":"اختر مكان حفظ الويكي الجديد كملف واحد",
	"Row/Advanced":"متقدم","Row/Plugins":"الإضافات",
	"Advanced/Backups":"النسخ الاحتياطية","Advanced/SaveBackup":"حفظ نسخة احتياطية عند كل حفظ","Advanced/RevealBackups":"إظهار النسخ الاحتياطية",
	"Advanced/ServerNote":"تتحكم هذه الخيارات في كيفية تقديم مجلد الويكي عبر HTTP. تصبح سارية المفعول في المرة القادمة التي يُفتح فيها مجلد الويكي.",
	"Advanced/Server":"الخادم","Advanced/Host":"المضيف","Advanced/Port":"المنفذ","Advanced/PathPrefix":"بادئة المسار","Advanced/RootTiddler":"تيدلر الجذر",
	"Advanced/Gzip":"ضغط الاستجابات (gzip)","Advanced/Access":"الوصول","Advanced/Credentials":"ملف بيانات الاعتماد","Advanced/AnonUsername":"اسم مستخدم مجهول",
	"Advanced/Readers":"القُرّاء","Advanced/Writers":"الكُتّاب",
	"PluginChooser/Heading":"إدارة الإضافات","PluginChooser/Close":"إغلاق","PluginChooser/OpenWarning":"هذا الويكي مفتوح حاليًا. أغلق نافذته أولًا ثم انقر على تطبيق.",
	"PluginChooser/FilterPlaceholder":"تصفية الإضافات…","PluginChooser/Clear":"مسح","PluginChooser/NoMatch":"لا توجد إضافات تطابق عامل التصفية.","PluginChooser/Apply":"تطبيق التغييرات","PluginChooser/Cancel":"إلغاء"
};

T["fa-IR"] = {
	_empty: "برای شروع، یک فایل یا پوشهٔ ~TiddlyWiki اضافه کنید.\n\nبرای مرور روی دکمه‌های بالا کلیک کنید، یا از کاوشگر فایل/Finder بکشید و رها کنید.",
	"Toolbar/AddWikiFile":"افزودن فایل ویکی","Toolbar/AddWikiFolder":"افزودن پوشهٔ ویکی","Toolbar/Backstage":"پشت صحنه",
	"Toolbar/CreateWikiFolder":"ایجاد پوشهٔ ویکی جدید","Toolbar/CreateWiki":"ایجاد ویکی جدید","Toolbar/CreateFromTemplate":"ایجاد از روی یک الگو",
	"Toolbar/NoTemplates":"هیچ الگویی تعریف نشده است – به تنظیمات مراجعه کنید","Toolbar/From":"از","Toolbar/CloneExisting":"همسان‌سازی یک ویکی موجود",
	"Toolbar/NoWikisToClone":"هیچ ویکی‌ای برای همسان‌سازی در دسترس نیست","Toolbar/Help":"راهنما","Toolbar/Settings":"تنظیمات","Toolbar/Language":"زبان",
	"List/SearchPlaceholder":"جستجو","List/ClearSearch":"پاک کردن جستجو",
	"Row/Untitled":"بدون عنوان","Row/Open":"باز کردن","Row/Reveal":"نمایش","Row/Remove":"حذف","Row/ToFolder":"به پوشه","Row/ToFile":"به فایل",
	"Row/ToFolderTooltip":"یک پوشهٔ خالی برای پوشهٔ ویکی جدید انتخاب (یا ایجاد) کنید","Row/ToFileTooltip":"محل ذخیرهٔ ویکی تک‌فایلی جدید را انتخاب کنید",
	"Row/Advanced":"پیشرفته","Row/Plugins":"افزونه‌ها",
	"Advanced/Backups":"پشتیبان‌گیری‌ها","Advanced/SaveBackup":"ذخیرهٔ یک نسخهٔ پشتیبان در هر بار ذخیره","Advanced/RevealBackups":"نمایش پشتیبان‌ها",
	"Advanced/ServerNote":"این گزینه‌ها نحوهٔ ارائهٔ پوشهٔ ویکی از طریق HTTP را کنترل می‌کنند. در دفعهٔ بعدی که پوشهٔ ویکی باز شود اعمال می‌شوند.",
	"Advanced/Server":"سرور","Advanced/Host":"میزبان","Advanced/Port":"درگاه","Advanced/PathPrefix":"پیشوند مسیر","Advanced/RootTiddler":"تیدلر ریشه",
	"Advanced/Gzip":"فشرده‌سازی پاسخ‌ها (gzip)","Advanced/Access":"دسترسی","Advanced/Credentials":"فایل اعتبارنامه","Advanced/AnonUsername":"نام کاربری ناشناس",
	"Advanced/Readers":"خوانندگان","Advanced/Writers":"نویسندگان",
	"PluginChooser/Heading":"مدیریت افزونه‌ها","PluginChooser/Close":"بستن","PluginChooser/OpenWarning":"این ویکی هم‌اکنون باز است. ابتدا پنجرهٔ آن را ببندید و سپس روی اعمال کلیک کنید.",
	"PluginChooser/FilterPlaceholder":"فیلتر کردن افزونه‌ها…","PluginChooser/Clear":"پاک کردن","PluginChooser/NoMatch":"هیچ افزونه‌ای با فیلتر شما مطابقت ندارد.","PluginChooser/Apply":"اعمال تغییرات","PluginChooser/Cancel":"لغو"
};

T["hi-IN"] = {
	_empty: "शुरू करने के लिए एक ~TiddlyWiki फ़ाइल या फ़ोल्डर जोड़ें।\n\nब्राउज़ करने के लिए ऊपर दिए बटनों पर क्लिक करें, या अपने फ़ाइल एक्सप्लोरर/Finder से खींचकर छोड़ें।",
	"Toolbar/AddWikiFile":"विकि फ़ाइल जोड़ें","Toolbar/AddWikiFolder":"विकि फ़ोल्डर जोड़ें","Toolbar/Backstage":"बैकस्टेज",
	"Toolbar/CreateWikiFolder":"नया विकि फ़ोल्डर बनाएँ","Toolbar/CreateWiki":"नई विकि बनाएँ","Toolbar/CreateFromTemplate":"टेम्पलेट से बनाएँ",
	"Toolbar/NoTemplates":"कोई टेम्पलेट परिभाषित नहीं – सेटिंग्स देखें","Toolbar/From":"से","Toolbar/CloneExisting":"मौजूदा विकि का क्लोन बनाएँ",
	"Toolbar/NoWikisToClone":"क्लोन करने के लिए कोई विकि उपलब्ध नहीं","Toolbar/Help":"सहायता","Toolbar/Settings":"सेटिंग्स","Toolbar/Language":"भाषा",
	"List/SearchPlaceholder":"खोजें","List/ClearSearch":"खोज साफ़ करें",
	"Row/Untitled":"बिना शीर्षक","Row/Open":"खोलें","Row/Reveal":"दिखाएँ","Row/Remove":"हटाएँ","Row/ToFolder":"फ़ोल्डर में","Row/ToFile":"फ़ाइल में",
	"Row/ToFolderTooltip":"नए विकि फ़ोल्डर के लिए एक खाली फ़ोल्डर चुनें (या बनाएँ)","Row/ToFileTooltip":"नई एकल-फ़ाइल विकि को सहेजने का स्थान चुनें",
	"Row/Advanced":"उन्नत","Row/Plugins":"प्लगइन",
	"Advanced/Backups":"बैकअप","Advanced/SaveBackup":"हर बार सहेजने पर एक बैकअप सहेजें","Advanced/RevealBackups":"बैकअप दिखाएँ",
	"Advanced/ServerNote":"ये विकल्प नियंत्रित करते हैं कि विकि फ़ोल्डर HTTP पर कैसे परोसा जाए। ये अगली बार विकि फ़ोल्डर खोलने पर प्रभावी होते हैं।",
	"Advanced/Server":"सर्वर","Advanced/Host":"होस्ट","Advanced/Port":"पोर्ट","Advanced/PathPrefix":"पथ उपसर्ग","Advanced/RootTiddler":"रूट टिड्लर",
	"Advanced/Gzip":"प्रतिक्रियाएँ संपीड़ित करें (gzip)","Advanced/Access":"पहुँच","Advanced/Credentials":"क्रेडेंशियल फ़ाइल","Advanced/AnonUsername":"अनाम उपयोगकर्ता नाम",
	"Advanced/Readers":"पाठक","Advanced/Writers":"लेखक",
	"PluginChooser/Heading":"प्लगइन प्रबंधित करें","PluginChooser/Close":"बंद करें","PluginChooser/OpenWarning":"यह विकि अभी खुली है। पहले इसकी विंडो बंद करें, फिर लागू करें पर क्लिक करें।",
	"PluginChooser/FilterPlaceholder":"प्लगइन फ़िल्टर करें…","PluginChooser/Clear":"साफ़ करें","PluginChooser/NoMatch":"आपके फ़िल्टर से कोई प्लगइन मेल नहीं खाता।","PluginChooser/Apply":"परिवर्तन लागू करें","PluginChooser/Cancel":"रद्द करें"
};

T["pa-IN"] = {
	_empty: "ਸ਼ੁਰੂ ਕਰਨ ਲਈ ਇੱਕ ~TiddlyWiki ਫ਼ਾਈਲ ਜਾਂ ਫੋਲਡਰ ਸ਼ਾਮਲ ਕਰੋ।\n\nਬ੍ਰਾਊਜ਼ ਕਰਨ ਲਈ ਉੱਪਰਲੇ ਬਟਨ ਦਬਾਓ, ਜਾਂ ਆਪਣੇ ਫ਼ਾਈਲ ਐਕਸਪਲੋਰਰ/Finder ਤੋਂ ਖਿੱਚ ਕੇ ਛੱਡੋ।",
	"Toolbar/AddWikiFile":"ਵਿਕੀ ਫ਼ਾਈਲ ਸ਼ਾਮਲ ਕਰੋ","Toolbar/AddWikiFolder":"ਵਿਕੀ ਫੋਲਡਰ ਸ਼ਾਮਲ ਕਰੋ","Toolbar/Backstage":"ਬੈਕਸਟੇਜ",
	"Toolbar/CreateWikiFolder":"ਨਵਾਂ ਵਿਕੀ ਫੋਲਡਰ ਬਣਾਓ","Toolbar/CreateWiki":"ਨਵੀਂ ਵਿਕੀ ਬਣਾਓ","Toolbar/CreateFromTemplate":"ਟੈਂਪਲੇਟ ਤੋਂ ਬਣਾਓ",
	"Toolbar/NoTemplates":"ਕੋਈ ਟੈਂਪਲੇਟ ਪਰਿਭਾਸ਼ਿਤ ਨਹੀਂ – ਸੈਟਿੰਗਾਂ ਵੇਖੋ","Toolbar/From":"ਤੋਂ","Toolbar/CloneExisting":"ਮੌਜੂਦਾ ਵਿਕੀ ਦਾ ਕਲੋਨ ਬਣਾਓ",
	"Toolbar/NoWikisToClone":"ਕਲੋਨ ਕਰਨ ਲਈ ਕੋਈ ਵਿਕੀ ਉਪਲਬਧ ਨਹੀਂ","Toolbar/Help":"ਮਦਦ","Toolbar/Settings":"ਸੈਟਿੰਗਾਂ","Toolbar/Language":"ਭਾਸ਼ਾ",
	"List/SearchPlaceholder":"ਖੋਜੋ","List/ClearSearch":"ਖੋਜ ਸਾਫ਼ ਕਰੋ",
	"Row/Untitled":"ਬਿਨਾਂ ਸਿਰਲੇਖ","Row/Open":"ਖੋਲ੍ਹੋ","Row/Reveal":"ਵਿਖਾਓ","Row/Remove":"ਹਟਾਓ","Row/ToFolder":"ਫੋਲਡਰ ਵਿੱਚ","Row/ToFile":"ਫ਼ਾਈਲ ਵਿੱਚ",
	"Row/ToFolderTooltip":"ਨਵੇਂ ਵਿਕੀ ਫੋਲਡਰ ਲਈ ਇੱਕ ਖਾਲੀ ਫੋਲਡਰ ਚੁਣੋ (ਜਾਂ ਬਣਾਓ)","Row/ToFileTooltip":"ਨਵੀਂ ਇੱਕ-ਫ਼ਾਈਲ ਵਿਕੀ ਨੂੰ ਸੰਭਾਲਣ ਲਈ ਥਾਂ ਚੁਣੋ",
	"Row/Advanced":"ਉੱਨਤ","Row/Plugins":"ਪਲੱਗਇਨ",
	"Advanced/Backups":"ਬੈਕਅੱਪ","Advanced/SaveBackup":"ਹਰ ਵਾਰ ਸੰਭਾਲਣ 'ਤੇ ਇੱਕ ਬੈਕਅੱਪ ਸੰਭਾਲੋ","Advanced/RevealBackups":"ਬੈਕਅੱਪ ਵਿਖਾਓ",
	"Advanced/ServerNote":"ਇਹ ਚੋਣਾਂ ਕੰਟਰੋਲ ਕਰਦੀਆਂ ਹਨ ਕਿ ਵਿਕੀ ਫੋਲਡਰ HTTP ਉੱਤੇ ਕਿਵੇਂ ਪਰੋਸਿਆ ਜਾਂਦਾ ਹੈ। ਇਹ ਅਗਲੀ ਵਾਰ ਵਿਕੀ ਫੋਲਡਰ ਖੋਲ੍ਹਣ 'ਤੇ ਲਾਗੂ ਹੁੰਦੀਆਂ ਹਨ।",
	"Advanced/Server":"ਸਰਵਰ","Advanced/Host":"ਹੋਸਟ","Advanced/Port":"ਪੋਰਟ","Advanced/PathPrefix":"ਪਾਥ ਅਗੇਤਰ","Advanced/RootTiddler":"ਰੂਟ ਟਿਡਲਰ",
	"Advanced/Gzip":"ਜਵਾਬ ਸੰਕੁਚਿਤ ਕਰੋ (gzip)","Advanced/Access":"ਪਹੁੰਚ","Advanced/Credentials":"ਕ੍ਰੈਡੈਂਸ਼ਲ ਫ਼ਾਈਲ","Advanced/AnonUsername":"ਗੁਮਨਾਮ ਵਰਤੋਂਕਾਰ ਨਾਮ",
	"Advanced/Readers":"ਪਾਠਕ","Advanced/Writers":"ਲੇਖਕ",
	"PluginChooser/Heading":"ਪਲੱਗਇਨ ਪ੍ਰਬੰਧਿਤ ਕਰੋ","PluginChooser/Close":"ਬੰਦ ਕਰੋ","PluginChooser/OpenWarning":"ਇਹ ਵਿਕੀ ਇਸ ਵੇਲੇ ਖੁੱਲ੍ਹੀ ਹੈ। ਪਹਿਲਾਂ ਇਸਦੀ ਵਿੰਡੋ ਬੰਦ ਕਰੋ, ਫਿਰ ਲਾਗੂ ਕਰੋ 'ਤੇ ਕਲਿੱਕ ਕਰੋ।",
	"PluginChooser/FilterPlaceholder":"ਪਲੱਗਇਨ ਫਿਲਟਰ ਕਰੋ…","PluginChooser/Clear":"ਸਾਫ਼ ਕਰੋ","PluginChooser/NoMatch":"ਤੁਹਾਡੇ ਫਿਲਟਰ ਨਾਲ ਕੋਈ ਪਲੱਗਇਨ ਮੇਲ ਨਹੀਂ ਖਾਂਦਾ।","PluginChooser/Apply":"ਤਬਦੀਲੀਆਂ ਲਾਗੂ ਕਰੋ","PluginChooser/Cancel":"ਰੱਦ ਕਰੋ"
};

T["ia-IA"] = {
	_empty: "Adde un file o un dossier ~TiddlyWiki pro comenciar.\n\nClicca le buttones supra pro navigar, o trahe e lassa cader ex tu explorator de files/Finder.",
	"Toolbar/AddWikiFile":"Adder file wiki","Toolbar/AddWikiFolder":"Adder dossier wiki","Toolbar/Backstage":"Coulisses",
	"Toolbar/CreateWikiFolder":"Crear nove dossier wiki","Toolbar/CreateWiki":"Crear nove wiki","Toolbar/CreateFromTemplate":"Crear ex un patrono",
	"Toolbar/NoTemplates":"Nulle patronos definite – vide Configuration","Toolbar/From":"ex","Toolbar/CloneExisting":"Clonar un wiki existente",
	"Toolbar/NoWikisToClone":"Nulle wikis disponibile a clonar","Toolbar/Help":"Adjuta","Toolbar/Settings":"Configuration","Toolbar/Language":"Lingua",
	"List/SearchPlaceholder":"cercar","List/ClearSearch":"Rader le recerca",
	"Row/Untitled":"Sin titulo","Row/Open":"aperir","Row/Reveal":"revelar","Row/Remove":"remover","Row/ToFolder":"a dossier","Row/ToFile":"a file",
	"Row/ToFolderTooltip":"Selige (o crea) un dossier vacue pro le nove dossier wiki","Row/ToFileTooltip":"Selige ubi salveguardar le nove wiki in un sol file",
	"Row/Advanced":"avantiate","Row/Plugins":"plugins",
	"Advanced/Backups":"Copias de reserva","Advanced/SaveBackup":"Salveguardar un copia de reserva a cata salveguarda","Advanced/RevealBackups":"revelar copias de reserva",
	"Advanced/ServerNote":"Iste optiones controla como le dossier wiki es servite via HTTP. Illos entra in vigor le proxime vice que le dossier wiki es aperite.",
	"Advanced/Server":"Servitor","Advanced/Host":"Hospite","Advanced/Port":"Porto","Advanced/PathPrefix":"Prefixo de cammino","Advanced/RootTiddler":"Tiddler radice",
	"Advanced/Gzip":"Comprimer le responsas (gzip)","Advanced/Access":"Accesso","Advanced/Credentials":"File de credentiales","Advanced/AnonUsername":"Nomine de usator anonyme",
	"Advanced/Readers":"Lectores","Advanced/Writers":"Scriptores",
	"PluginChooser/Heading":"Gerer le plugins","PluginChooser/Close":"Clauder","PluginChooser/OpenWarning":"Iste wiki es actualmente aperte. Claude prime su fenestra, postea clicca Applicar.",
	"PluginChooser/FilterPlaceholder":"Filtrar plugins…","PluginChooser/Clear":"Rader","PluginChooser/NoMatch":"Nulle plugin corresponde a tu filtro.","PluginChooser/Apply":"Applicar cambiamentos","PluginChooser/Cancel":"Cancellar"
};

T["ja-JP"] = {
	_empty: "始めるには ~TiddlyWiki のファイルまたはフォルダーを追加してください。\n\n上のボタンをクリックして参照するか、ファイルエクスプローラー/Finder からドラッグ＆ドロップしてください。",
	"Toolbar/AddWikiFile":"Wikiファイルを追加","Toolbar/AddWikiFolder":"Wikiフォルダーを追加","Toolbar/Backstage":"バックステージ",
	"Toolbar/CreateWikiFolder":"新しいWikiフォルダーを作成","Toolbar/CreateWiki":"新しいWikiを作成","Toolbar/CreateFromTemplate":"テンプレートから作成",
	"Toolbar/NoTemplates":"テンプレートが定義されていません — 設定を参照","Toolbar/From":"元：","Toolbar/CloneExisting":"既存のWikiを複製",
	"Toolbar/NoWikisToClone":"複製できるWikiがありません","Toolbar/Help":"ヘルプ","Toolbar/Settings":"設定","Toolbar/Language":"言語",
	"List/SearchPlaceholder":"検索","List/ClearSearch":"検索をクリア",
	"Row/Untitled":"無題","Row/Open":"開く","Row/Reveal":"表示","Row/Remove":"削除","Row/ToFolder":"フォルダーへ","Row/ToFile":"ファイルへ",
	"Row/ToFolderTooltip":"新しいWikiフォルダー用の空のフォルダーを選択（または作成）してください","Row/ToFileTooltip":"新しい単一ファイルWikiの保存先を選択してください",
	"Row/Advanced":"詳細","Row/Plugins":"プラグイン",
	"Advanced/Backups":"バックアップ","Advanced/SaveBackup":"保存のたびにバックアップを保存","Advanced/RevealBackups":"バックアップを表示",
	"Advanced/ServerNote":"これらのオプションは、WikiフォルダーをHTTP経由でどのように配信するかを制御します。次回Wikiフォルダーを開いたときに有効になります。",
	"Advanced/Server":"サーバー","Advanced/Host":"ホスト","Advanced/Port":"ポート","Advanced/PathPrefix":"パスのプレフィックス","Advanced/RootTiddler":"ルートTiddler",
	"Advanced/Gzip":"応答を圧縮（gzip）","Advanced/Access":"アクセス","Advanced/Credentials":"認証情報ファイル","Advanced/AnonUsername":"匿名ユーザー名",
	"Advanced/Readers":"閲覧者","Advanced/Writers":"編集者",
	"PluginChooser/Heading":"プラグインの管理","PluginChooser/Close":"閉じる","PluginChooser/OpenWarning":"このWikiは現在開いています。先にウィンドウを閉じてから「適用」をクリックしてください。",
	"PluginChooser/FilterPlaceholder":"プラグインを絞り込む…","PluginChooser/Clear":"クリア","PluginChooser/NoMatch":"フィルターに一致するプラグインがありません。","PluginChooser/Apply":"変更を適用","PluginChooser/Cancel":"キャンセル"
};

T["ko-KR"] = {
	_empty: "시작하려면 ~TiddlyWiki 파일이나 폴더를 추가하세요.\n\n위의 버튼을 클릭하여 찾아보거나, 파일 탐색기/Finder에서 끌어다 놓으세요.",
	"Toolbar/AddWikiFile":"위키 파일 추가","Toolbar/AddWikiFolder":"위키 폴더 추가","Toolbar/Backstage":"백스테이지",
	"Toolbar/CreateWikiFolder":"새 위키 폴더 만들기","Toolbar/CreateWiki":"새 위키 만들기","Toolbar/CreateFromTemplate":"템플릿에서 만들기",
	"Toolbar/NoTemplates":"정의된 템플릿이 없습니다 — 설정을 참조하세요","Toolbar/From":"원본:","Toolbar/CloneExisting":"기존 위키 복제",
	"Toolbar/NoWikisToClone":"복제할 수 있는 위키가 없습니다","Toolbar/Help":"도움말","Toolbar/Settings":"설정","Toolbar/Language":"언어",
	"List/SearchPlaceholder":"검색","List/ClearSearch":"검색 지우기",
	"Row/Untitled":"제목 없음","Row/Open":"열기","Row/Reveal":"표시","Row/Remove":"제거","Row/ToFolder":"폴더로","Row/ToFile":"파일로",
	"Row/ToFolderTooltip":"새 위키 폴더를 위한 빈 폴더를 선택(또는 생성)하세요","Row/ToFileTooltip":"새 단일 파일 위키를 저장할 위치를 선택하세요",
	"Row/Advanced":"고급","Row/Plugins":"플러그인",
	"Advanced/Backups":"백업","Advanced/SaveBackup":"저장할 때마다 백업 저장","Advanced/RevealBackups":"백업 표시",
	"Advanced/ServerNote":"이 옵션은 위키 폴더가 HTTP를 통해 제공되는 방식을 제어합니다. 다음에 위키 폴더를 열 때 적용됩니다.",
	"Advanced/Server":"서버","Advanced/Host":"호스트","Advanced/Port":"포트","Advanced/PathPrefix":"경로 접두사","Advanced/RootTiddler":"루트 Tiddler",
	"Advanced/Gzip":"응답 압축(gzip)","Advanced/Access":"접근","Advanced/Credentials":"자격 증명 파일","Advanced/AnonUsername":"익명 사용자 이름",
	"Advanced/Readers":"읽기 사용자","Advanced/Writers":"쓰기 사용자",
	"PluginChooser/Heading":"플러그인 관리","PluginChooser/Close":"닫기","PluginChooser/OpenWarning":"이 위키는 현재 열려 있습니다. 먼저 창을 닫은 다음 적용을 클릭하세요.",
	"PluginChooser/FilterPlaceholder":"플러그인 필터링…","PluginChooser/Clear":"지우기","PluginChooser/NoMatch":"필터와 일치하는 플러그인이 없습니다.","PluginChooser/Apply":"변경 사항 적용","PluginChooser/Cancel":"취소"
};

T["zh-Hans"] = {
	_empty: "添加一个 ~TiddlyWiki 文件或文件夹即可开始。\n\n点击上方按钮浏览，或从文件资源管理器/访达拖放。",
	"Toolbar/AddWikiFile":"添加 wiki 文件","Toolbar/AddWikiFolder":"添加 wiki 文件夹","Toolbar/Backstage":"后台",
	"Toolbar/CreateWikiFolder":"新建 wiki 文件夹","Toolbar/CreateWiki":"新建 wiki","Toolbar/CreateFromTemplate":"从模板创建",
	"Toolbar/NoTemplates":"未定义模板 —— 请参阅设置","Toolbar/From":"来自","Toolbar/CloneExisting":"克隆现有 wiki",
	"Toolbar/NoWikisToClone":"没有可克隆的 wiki","Toolbar/Help":"帮助","Toolbar/Settings":"设置","Toolbar/Language":"语言",
	"List/SearchPlaceholder":"搜索","List/ClearSearch":"清除搜索",
	"Row/Untitled":"无标题","Row/Open":"打开","Row/Reveal":"显示","Row/Remove":"移除","Row/ToFolder":"转为文件夹","Row/ToFile":"转为文件",
	"Row/ToFolderTooltip":"为新的 wiki 文件夹选择（或创建）一个空文件夹","Row/ToFileTooltip":"选择新的单文件 wiki 的保存位置",
	"Row/Advanced":"高级","Row/Plugins":"插件",
	"Advanced/Backups":"备份","Advanced/SaveBackup":"每次保存时保存一个备份","Advanced/RevealBackups":"显示备份",
	"Advanced/ServerNote":"这些选项控制 wiki 文件夹如何通过 HTTP 提供服务。它们将在下次打开该 wiki 文件夹时生效。",
	"Advanced/Server":"服务器","Advanced/Host":"主机","Advanced/Port":"端口","Advanced/PathPrefix":"路径前缀","Advanced/RootTiddler":"根 Tiddler",
	"Advanced/Gzip":"压缩响应（gzip）","Advanced/Access":"访问","Advanced/Credentials":"凭据文件","Advanced/AnonUsername":"匿名用户名",
	"Advanced/Readers":"读者","Advanced/Writers":"写者",
	"PluginChooser/Heading":"管理插件","PluginChooser/Close":"关闭","PluginChooser/OpenWarning":"此 wiki 当前已打开。请先关闭其窗口，然后点击应用。",
	"PluginChooser/FilterPlaceholder":"筛选插件…","PluginChooser/Clear":"清除","PluginChooser/NoMatch":"没有插件与您的筛选条件匹配。","PluginChooser/Apply":"应用更改","PluginChooser/Cancel":"取消"
};

T["zh-Hant"] = {
	_empty: "新增一個 ~TiddlyWiki 檔案或資料夾即可開始。\n\n點選上方按鈕瀏覽，或從檔案總管/Finder 拖放。",
	"Toolbar/AddWikiFile":"新增 wiki 檔案","Toolbar/AddWikiFolder":"新增 wiki 資料夾","Toolbar/Backstage":"後台",
	"Toolbar/CreateWikiFolder":"建立新的 wiki 資料夾","Toolbar/CreateWiki":"建立新的 wiki","Toolbar/CreateFromTemplate":"從範本建立",
	"Toolbar/NoTemplates":"未定義範本 —— 請參閱設定","Toolbar/From":"來自","Toolbar/CloneExisting":"複製現有 wiki",
	"Toolbar/NoWikisToClone":"沒有可複製的 wiki","Toolbar/Help":"說明","Toolbar/Settings":"設定","Toolbar/Language":"語言",
	"List/SearchPlaceholder":"搜尋","List/ClearSearch":"清除搜尋",
	"Row/Untitled":"無標題","Row/Open":"開啟","Row/Reveal":"顯示","Row/Remove":"移除","Row/ToFolder":"轉為資料夾","Row/ToFile":"轉為檔案",
	"Row/ToFolderTooltip":"為新的 wiki 資料夾選擇（或建立）一個空資料夾","Row/ToFileTooltip":"選擇新的單一檔案 wiki 的儲存位置",
	"Row/Advanced":"進階","Row/Plugins":"外掛",
	"Advanced/Backups":"備份","Advanced/SaveBackup":"每次儲存時儲存一份備份","Advanced/RevealBackups":"顯示備份",
	"Advanced/ServerNote":"這些選項控制 wiki 資料夾如何透過 HTTP 提供服務。它們將在下次開啟該 wiki 資料夾時生效。",
	"Advanced/Server":"伺服器","Advanced/Host":"主機","Advanced/Port":"連接埠","Advanced/PathPrefix":"路徑前綴","Advanced/RootTiddler":"根 Tiddler",
	"Advanced/Gzip":"壓縮回應（gzip）","Advanced/Access":"存取","Advanced/Credentials":"憑證檔案","Advanced/AnonUsername":"匿名使用者名稱",
	"Advanced/Readers":"讀者","Advanced/Writers":"寫者",
	"PluginChooser/Heading":"管理外掛","PluginChooser/Close":"關閉","PluginChooser/OpenWarning":"此 wiki 目前已開啟。請先關閉其視窗，然後點選套用。",
	"PluginChooser/FilterPlaceholder":"篩選外掛…","PluginChooser/Clear":"清除","PluginChooser/NoMatch":"沒有外掛符合您的篩選條件。","PluginChooser/Apply":"套用變更","PluginChooser/Cancel":"取消"
};

// Plugin-update strings (added later) — merged into the base dicts below so the German and
// Chinese variants inherit them via the aliases. Keys: Update / UpdateAvailable / Updated
// (PluginChooser) and Row/PluginUpdates (the wiki-list badge tooltip).
var PLUGIN_UPDATE = {
	"de-DE": ["Aktualisieren", "Eine neuere Version ist enthalten – zum Aktualisieren klicken", "Aktualisiert", "Plugin-Updates verfügbar"],
	"fr-FR": ["Mettre à jour", "Une version plus récente est fournie — cliquez pour mettre à jour", "Mis à jour", "Mises à jour de plugins disponibles"],
	"es-ES": ["Actualizar", "Se incluye una versión más reciente: haz clic para actualizar", "Actualizado", "Actualizaciones de complementos disponibles"],
	"ca-ES": ["Actualitza", "S’inclou una versió més recent: fes clic per actualitzar", "Actualitzat", "Hi ha actualitzacions de connectors"],
	"it-IT": ["Aggiorna", "È inclusa una versione più recente — fai clic per aggiornare", "Aggiornato", "Aggiornamenti dei plugin disponibili"],
	"pt-BR": ["Atualizar", "Uma versão mais recente está incluída — clique para atualizar", "Atualizado", "Atualizações de plugins disponíveis"],
	"pt-PT": ["Atualizar", "Está incluída uma versão mais recente — clique para atualizar", "Atualizado", "Atualizações de plugins disponíveis"],
	"nl-NL": ["Bijwerken", "Een nieuwere versie is meegeleverd — klik om bij te werken", "Bijgewerkt", "Plug-in-updates beschikbaar"],
	"da-DK": ["Opdatér", "En nyere version er inkluderet — klik for at opdatere", "Opdateret", "Plugin-opdateringer tilgængelige"],
	"sv-SE": ["Uppdatera", "En nyare version medföljer — klicka för att uppdatera", "Uppdaterad", "Tilläggsuppdateringar tillgängliga"],
	"pl-PL": ["Aktualizuj", "Dołączono nowszą wersję — kliknij, aby zaktualizować", "Zaktualizowano", "Dostępne aktualizacje wtyczek"],
	"cs-CZ": ["Aktualizovat", "Je přiložena novější verze — aktualizujte kliknutím", "Aktualizováno", "Jsou dostupné aktualizace pluginů"],
	"sk-SK": ["Aktualizovať", "Je priložená novšia verzia — aktualizujte kliknutím", "Aktualizované", "Sú dostupné aktualizácie pluginov"],
	"sl-SI": ["Posodobi", "Priložena je novejša različica — kliknite za posodobitev", "Posodobljeno", "Na voljo so posodobitve vtičnikov"],
	"mk-MK": ["Ажурирај", "Вклучена е поново верзија — кликнете за ажурирање", "Ажурирано", "Достапни се ажурирања на приклучоци"],
	"ru-RU": ["Обновить", "В комплекте есть более новая версия — нажмите, чтобы обновить", "Обновлено", "Доступны обновления плагинов"],
	"el-GR": ["Ενημέρωση", "Περιλαμβάνεται νεότερη έκδοση — κάντε κλικ για ενημέρωση", "Ενημερώθηκε", "Διαθέσιμες ενημερώσεις προσθέτων"],
	"he-IL": ["עדכן", "כלולה גרסה חדשה יותר — לחצו לעדכון", "עודכן", "קיימים עדכוני תוספים"],
	"ar-PS": ["تحديث", "يتوفّر إصدار أحدث — انقر للتحديث", "تم التحديث", "تتوفّر تحديثات للإضافات"],
	"fa-IR": ["به‌روزرسانی", "نسخهٔ جدیدتری همراه است — برای به‌روزرسانی کلیک کنید", "به‌روزرسانی شد", "به‌روزرسانی افزونه‌ها در دسترس است"],
	"hi-IN": ["अपडेट करें", "एक नया संस्करण शामिल है — अपडेट करने के लिए क्लिक करें", "अपडेट किया गया", "प्लगइन अपडेट उपलब्ध हैं"],
	"pa-IN": ["ਅੱਪਡੇਟ ਕਰੋ", "ਇੱਕ ਨਵਾਂ ਸੰਸਕਰਣ ਸ਼ਾਮਲ ਹੈ — ਅੱਪਡੇਟ ਕਰਨ ਲਈ ਕਲਿੱਕ ਕਰੋ", "ਅੱਪਡੇਟ ਕੀਤਾ", "ਪਲੱਗਇਨ ਅੱਪਡੇਟ ਉਪਲਬਧ ਹਨ"],
	"ia-IA": ["Actualisar", "Un version plus recente es includite — clicca pro actualisar", "Actualisate", "Actualisationes de plugins disponibile"],
	"ja-JP": ["更新", "より新しいバージョンが同梱されています — クリックして更新", "更新しました", "プラグインの更新があります"],
	"ko-KR": ["업데이트", "더 새로운 버전이 포함되어 있습니다 — 클릭하여 업데이트", "업데이트됨", "플러그인 업데이트가 있습니다"],
	"zh-Hans": ["更新", "已捆绑更新的版本 —— 点击以更新", "已更新", "有可用的插件更新"],
	"zh-Hant": ["更新", "已隨附較新版本 —— 點選以更新", "已更新", "有可用的外掛更新"]
};
Object.keys(PLUGIN_UPDATE).forEach(function(lang) {
	if(!T[lang]) { return; }
	var v = PLUGIN_UPDATE[lang];
	T[lang]["PluginChooser/Update"]          = v[0];
	T[lang]["PluginChooser/UpdateAvailable"] = v[1];
	T[lang]["PluginChooser/Updated"]         = v[2];
	T[lang]["Row/PluginUpdates"]             = v[3];
});

// PluginChooser tab captions: [Plugins, Languages, Themes].
var TAB_CAPTIONS = {
	"de-DE": ["Plugins", "Sprachen", "Designs"],
	"fr-FR": ["Plugins", "Langues", "Thèmes"],
	"es-ES": ["Complementos", "Idiomas", "Temas"],
	"ca-ES": ["Connectors", "Idiomes", "Temes"],
	"it-IT": ["Plugin", "Lingue", "Temi"],
	"pt-BR": ["Plugins", "Idiomas", "Temas"],
	"pt-PT": ["Plugins", "Idiomas", "Temas"],
	"nl-NL": ["Plug-ins", "Talen", "Thema's"],
	"da-DK": ["Plugins", "Sprog", "Temaer"],
	"sv-SE": ["Tillägg", "Språk", "Teman"],
	"pl-PL": ["Wtyczki", "Języki", "Motywy"],
	"cs-CZ": ["Pluginy", "Jazyky", "Motivy"],
	"sk-SK": ["Pluginy", "Jazyky", "Témy"],
	"sl-SI": ["Vtičniki", "Jeziki", "Teme"],
	"mk-MK": ["Приклучоци", "Јазици", "Теми"],
	"ru-RU": ["Плагины", "Языки", "Темы"],
	"el-GR": ["Πρόσθετα", "Γλώσσες", "Θέματα"],
	"he-IL": ["תוספים", "שפות", "ערכות נושא"],
	"ar-PS": ["إضافات", "اللغات", "السمات"],
	"fa-IR": ["افزونه‌ها", "زبان‌ها", "پوسته‌ها"],
	"hi-IN": ["प्लगइन", "भाषाएँ", "थीम"],
	"pa-IN": ["ਪਲੱਗਇਨ", "ਭਾਸ਼ਾਵਾਂ", "ਥੀਮ"],
	"ia-IA": ["Plugins", "Linguas", "Themas"],
	"ja-JP": ["プラグイン", "言語", "テーマ"],
	"ko-KR": ["플러그인", "언어", "테마"],
	"zh-Hans": ["插件", "语言", "主题"],
	"zh-Hant": ["外掛", "語言", "佈景主題"]
};
Object.keys(TAB_CAPTIONS).forEach(function(lang) {
	if(!T[lang]) { return; }
	var v = TAB_CAPTIONS[lang];
	T[lang]["PluginChooser/Tab/plugin"]   = v[0];
	T[lang]["PluginChooser/Tab/language"] = v[1];
	T[lang]["PluginChooser/Tab/theme"]    = v[2];
});

// Variants reuse a base translation.
T["de-AT"] = T["de-DE"];
T["de-CH"] = T["de-DE"];   // de-CH conventionally writes ss for ß; handled below.
T["zh-CN"] = T["zh-Hans"];
T["zh-TW"] = T["zh-Hant"];
T["zh-HK"] = T["zh-Hant"];

// ── emit ───────────────────────────────────────────────────────────────────
function multidsBody(lang, dict) {
	var lines = ["title: $:/language/TiddlyDesktop/", ""];
	KEY_ORDER.forEach(function(key) {
		if(Object.prototype.hasOwnProperty.call(dict, key)) {
			var val = dict[key];
			if(lang === "de-CH") { val = val.replace(/ß/g, "ss"); }
			lines.push(key + ": " + val);
		}
	});
	return lines.join("\n") + "\n";
}
function emptyBody(lang, dict) {
	var text = dict._empty;
	if(!text) { return null; }
	if(lang === "de-CH") { text = text.replace(/ß/g, "ss"); }
	return "title: $:/language/TiddlyDesktop/List/EmptyMessage\n\n" + text + "\n";
}

var outRoot = __dirname, count = 0;
Object.keys(T).forEach(function(lang) {
	var dict = T[lang], dir = path.resolve(outRoot, lang);
	fs.mkdirSync(dir, {recursive: true});
	fs.writeFileSync(path.resolve(dir, "TiddlyDesktop.multids"), multidsBody(lang, dict));
	var empty = emptyBody(lang, dict);
	if(empty) { fs.writeFileSync(path.resolve(dir, "EmptyMessage.tid"), empty); }
	count++;
});
console.log("Wrote translations for " + count + " languages: " + Object.keys(T).sort().join(", "));
