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
	"Advanced/Backups","Advanced/SaveBackup","Advanced/KeepBackups","Advanced/RevealBackups","Advanced/ServerNote",
	"Advanced/Server","Advanced/Host","Advanced/Port","Advanced/PathPrefix","Advanced/RootTiddler",
	"Advanced/Gzip","Advanced/Access","Advanced/Credentials","Advanced/AnonUsername",
	"Advanced/Readers","Advanced/Writers",
	"PluginChooser/Tab/plugin","PluginChooser/Tab/language","PluginChooser/Tab/theme",
	"PluginChooser/Heading","PluginChooser/Close","PluginChooser/OpenWarning","PluginChooser/FilterPlaceholder",
	"PluginChooser/Clear","PluginChooser/NoMatch","PluginChooser/Apply","PluginChooser/Cancel",
	"PluginChooser/Reinstall","PluginChooser/ReinstallTooltip","PluginChooser/Reinstalled",
	"PluginChooser/Installed","PluginChooser/NotInstalled","PluginChooser/Versions",
	"PluginChooser/SourceBundled","PluginChooser/SourceExternal",
	"PluginChooser/Update","PluginChooser/UpdateAvailable","PluginChooser/Updated","Row/PluginUpdates",
	"Toolbar/ThemeLabel","Toolbar/PaletteLabel",
	"Toolbar/ViewLabel","Toolbar/ViewFull","Toolbar/ViewCompact",
	"Toolbar/CustomPluginFolder",
	"Toolbar/ConfigFolder","Toolbar/OpenConfigFolder","Toolbar/BackupFolder","Toolbar/OpenBackupFolder",
	"Share/Heading","Share/Cancel",
	"Share/TemplatesHeading","Share/TemplatesHelp","Share/DeleteTemplate","Share/TagsLabel",
	"Share/AddHeading","Share/AddHelp","Share/NamePlaceholder","Share/CreateTemplate",
	"Share/RulesHeading","Share/RulesHelp","Share/RulePlaceholder","Advanced/BackupsHelp"
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

// Per-row reinstall button strings: [Reinstall (label), ReinstallTooltip, Reinstalled (status)].
var REINSTALL = {
	"de-DE": ["Neu installieren", "Die mitgelieferte Version dieses Plugins neu installieren", "Neu installiert"],
	"fr-FR": ["Réinstaller", "Réinstaller la version fournie de ce plugin", "Réinstallé"],
	"es-ES": ["Reinstalar", "Reinstalar la versión incluida de este complemento", "Reinstalado"],
	"ca-ES": ["Reinstal·la", "Reinstal·la la versió inclosa d’aquest connector", "Reinstal·lat"],
	"it-IT": ["Reinstalla", "Reinstalla la versione inclusa di questo plugin", "Reinstallato"],
	"pt-BR": ["Reinstalar", "Reinstalar a versão incluída deste plugin", "Reinstalado"],
	"pt-PT": ["Reinstalar", "Reinstalar a versão incluída deste plugin", "Reinstalado"],
	"nl-NL": ["Opnieuw installeren", "De meegeleverde versie van deze plug-in opnieuw installeren", "Opnieuw geïnstalleerd"],
	"da-DK": ["Geninstallér", "Geninstallér den medfølgende version af dette plugin", "Geninstalleret"],
	"sv-SE": ["Installera om", "Installera om den medföljande versionen av detta tillägg", "Ominstallerad"],
	"pl-PL": ["Zainstaluj ponownie", "Zainstaluj ponownie dołączoną wersję tej wtyczki", "Zainstalowano ponownie"],
	"cs-CZ": ["Přeinstalovat", "Přeinstalovat přiloženou verzi tohoto pluginu", "Přeinstalováno"],
	"sk-SK": ["Preinštalovať", "Preinštalovať priloženú verziu tohto pluginu", "Preinštalované"],
	"sl-SI": ["Znova namesti", "Znova namesti priloženo različico tega vtičnika", "Znova nameščeno"],
	"mk-MK": ["Преинсталирај", "Преинсталирај ја вклучената верзија на овој приклучок", "Преинсталирано"],
	"ru-RU": ["Переустановить", "Переустановить встроенную версию этого плагина", "Переустановлено"],
	"el-GR": ["Επανεγκατάσταση", "Επανεγκατάσταση της ενσωματωμένης έκδοσης αυτού του προσθέτου", "Επανεγκαταστάθηκε"],
	"he-IL": ["התקן מחדש", "התקנה מחדש של הגרסה הכלולה של תוסף זה", "הותקן מחדש"],
	"ar-PS": ["إعادة التثبيت", "إعادة تثبيت النسخة المضمّنة من هذه الإضافة", "تمت إعادة التثبيت"],
	"fa-IR": ["نصب مجدد", "نصب مجدد نسخهٔ همراه این افزونه", "دوباره نصب شد"],
	"hi-IN": ["पुनः इंस्टॉल करें", "इस प्लगइन का साथ-शामिल संस्करण पुनः इंस्टॉल करें", "पुनः इंस्टॉल किया गया"],
	"pa-IN": ["ਮੁੜ ਇੰਸਟਾਲ ਕਰੋ", "ਇਸ ਪਲੱਗਇਨ ਦਾ ਨਾਲ-ਸ਼ਾਮਲ ਸੰਸਕਰਣ ਮੁੜ ਇੰਸਟਾਲ ਕਰੋ", "ਮੁੜ ਇੰਸਟਾਲ ਕੀਤਾ"],
	"ia-IA": ["Reinstallar", "Reinstallar le version includite de iste plugin", "Reinstallate"],
	"ja-JP": ["再インストール", "このプラグインの同梱版を再インストールします", "再インストールしました"],
	"ko-KR": ["다시 설치", "이 플러그인의 포함된 버전을 다시 설치합니다", "다시 설치됨"],
	"zh-Hans": ["重新安装", "重新安装此插件的捆绑版本", "已重新安装"],
	"zh-Hant": ["重新安裝", "重新安裝此外掛的隨附版本", "已重新安裝"]
};
Object.keys(REINSTALL).forEach(function(lang) {
	if(!T[lang]) { return; }
	var v = REINSTALL[lang];
	T[lang]["PluginChooser/Reinstall"]        = v[0];
	T[lang]["PluginChooser/ReinstallTooltip"] = v[1];
	T[lang]["PluginChooser/Reinstalled"]      = v[2];
});

// Version-row install state: [Installed (badge on the installed version), NotInstalled (the
// "none" radio that removes the plugin)]. Shown only when a plugin has several versions.
// [Installed, NotInstalled, Versions, SourceBundled, SourceExternal].
var INSTALL_STATE = {
	"de-DE": ["installiert", "Nicht installiert", "Versionen", "mitgeliefert", "extern"],
	"fr-FR": ["installé", "Non installé", "versions", "fourni", "externe"],
	"es-ES": ["instalado", "No instalado", "versiones", "incluido", "externo"],
	"ca-ES": ["instal·lat", "No instal·lat", "versions", "inclòs", "extern"],
	"it-IT": ["installato", "Non installato", "versioni", "incluso", "esterno"],
	"pt-BR": ["instalado", "Não instalado", "versões", "incluído", "externo"],
	"pt-PT": ["instalado", "Não instalado", "versões", "incluído", "externo"],
	"nl-NL": ["geïnstalleerd", "Niet geïnstalleerd", "versies", "meegeleverd", "extern"],
	"da-DK": ["installeret", "Ikke installeret", "versioner", "medfølgende", "ekstern"],
	"sv-SE": ["installerad", "Inte installerad", "versioner", "medföljande", "extern"],
	"pl-PL": ["zainstalowano", "Nie zainstalowano", "wersje", "dołączony", "zewnętrzny"],
	"cs-CZ": ["nainstalováno", "Nenainstalováno", "verze", "součástí", "externí"],
	"sk-SK": ["nainštalované", "Nenainštalované", "verzie", "súčasťou", "externý"],
	"sl-SI": ["nameščeno", "Ni nameščeno", "različice", "priloženo", "zunanji"],
	"mk-MK": ["инсталирано", "Не е инсталирано", "верзии", "вградено", "надворешно"],
	"ru-RU": ["установлено", "Не установлено", "версии", "встроенный", "внешний"],
	"el-GR": ["εγκατεστημένο", "Δεν είναι εγκατεστημένο", "εκδόσεις", "ενσωματωμένο", "εξωτερικό"],
	"he-IL": ["מותקן", "לא מותקן", "גרסאות", "מצורף", "חיצוני"],
	"ar-PS": ["مثبّت", "غير مثبّت", "إصدارات", "مضمّن", "خارجي"],
	"fa-IR": ["نصب‌شده", "نصب نشده", "نسخه‌ها", "همراه", "خارجی"],
	"hi-IN": ["इंस्टॉल किया गया", "इंस्टॉल नहीं है", "संस्करण", "साथ-शामिल", "बाहरी"],
	"pa-IN": ["ਇੰਸਟਾਲ ਕੀਤਾ", "ਇੰਸਟਾਲ ਨਹੀਂ ਹੈ", "ਸੰਸਕਰਣ", "ਨਾਲ-ਸ਼ਾਮਲ", "ਬਾਹਰੀ"],
	"ia-IA": ["installate", "Non installate", "versiones", "includite", "externe"],
	"ja-JP": ["インストール済み", "未インストール", "バージョン", "同梱", "外部"],
	"ko-KR": ["설치됨", "설치되지 않음", "버전", "포함됨", "외부"],
	"zh-Hans": ["已安装", "未安装", "个版本", "捆绑", "外部"],
	"zh-Hant": ["已安裝", "未安裝", "個版本", "隨附", "外部"]
};
Object.keys(INSTALL_STATE).forEach(function(lang) {
	if(!T[lang]) { return; }
	var v = INSTALL_STATE[lang];
	T[lang]["PluginChooser/Installed"]      = v[0];
	T[lang]["PluginChooser/NotInstalled"]   = v[1];
	T[lang]["PluginChooser/Versions"]       = v[2];
	T[lang]["PluginChooser/SourceBundled"]  = v[3];
	T[lang]["PluginChooser/SourceExternal"] = v[4];
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

// Per-wiki "Backups to keep (empty = all)" label in the advanced options.
var KEEP_BACKUPS = {
	"de-DE": "Backups behalten (leer = alle)",
	"fr-FR": "Sauvegardes à conserver (vide = toutes)",
	"es-ES": "Copias a conservar (vacío = todas)",
	"ca-ES": "Còpies a conservar (buit = totes)",
	"it-IT": "Backup da conservare (vuoto = tutti)",
	"pt-BR": "Backups a manter (vazio = todos)",
	"pt-PT": "Backups a manter (vazio = todos)",
	"nl-NL": "Back-ups bewaren (leeg = alle)",
	"da-DK": "Sikkerhedskopier at beholde (tom = alle)",
	"sv-SE": "Säkerhetskopior att behålla (tomt = alla)",
	"pl-PL": "Kopie do zachowania (puste = wszystkie)",
	"cs-CZ": "Počet záloh k zachování (prázdné = vše)",
	"sk-SK": "Počet záloh na zachovanie (prázdne = všetky)",
	"sl-SI": "Število varnostnih kopij (prazno = vse)",
	"mk-MK": "Резерви за чување (празно = сите)",
	"ru-RU": "Резервных копий (пусто = все)",
	"el-GR": "Αντίγραφα προς διατήρηση (κενό = όλα)",
	"he-IL": "גיבויים לשמירה (ריק = הכול)",
	"ar-PS": "النسخ الاحتياطية المحفوظة (فارغ = الكل)",
	"fa-IR": "تعداد پشتیبان‌ها (خالی = همه)",
	"hi-IN": "रखने योग्य बैकअप (खाली = सभी)",
	"pa-IN": "ਰੱਖਣ ਲਈ ਬੈਕਅੱਪ (ਖਾਲੀ = ਸਾਰੇ)",
	"ia-IA": "Copias de reserva a mantener (vacue = totes)",
	"ja-JP": "保持するバックアップ数（空＝すべて）",
	"ko-KR": "보관할 백업 수 (비우면 전체)",
	"zh-Hans": "保留的备份数（留空＝全部）",
	"zh-Hant": "保留的備份數（留空＝全部）"
};
Object.keys(KEEP_BACKUPS).forEach(function(lang) {
	if(T[lang]) { T[lang]["Advanced/KeepBackups"] = KEEP_BACKUPS[lang]; }
});

// Android WikiList additions: theme/palette pickers, config/backup/plugin folders, share picker.
// Keys: ThemeLabel, PaletteLabel, CustomPluginFolder, ConfigFolder, OpenConfigFolder,
//       BackupFolder, OpenBackupFolder, Share/Heading, Share/Cancel.
var ANDROID = {
	"de-DE": ["Design","Palette","Eigener Plugin-Ordner","Konfigurationsordner","Konfigurationsordner öffnen","Sicherungsordner","Sicherungsordner öffnen","Geteilten Inhalt hinzufügen zu…","Abbrechen"],
	"fr-FR": ["Thème","Palette","Dossier de plugins personnalisé","Dossier de configuration","Ouvrir le dossier de configuration","Dossier de sauvegarde","Ouvrir le dossier de sauvegarde","Ajouter le contenu partagé à…","Annuler"],
	"es-ES": ["Tema","Paleta","Carpeta de complementos personalizada","Carpeta de configuración","Abrir la carpeta de configuración","Carpeta de copias de seguridad","Abrir la carpeta de copias de seguridad","Añadir el contenido compartido a…","Cancelar"],
	"ca-ES": ["Tema","Paleta","Carpeta de connectors personalitzada","Carpeta de configuració","Obre la carpeta de configuració","Carpeta de còpies de seguretat","Obre la carpeta de còpies de seguretat","Afegeix el contingut compartit a…","Cancel·la"],
	"it-IT": ["Tema","Tavolozza","Cartella dei plugin personalizzata","Cartella di configurazione","Apri la cartella di configurazione","Cartella dei backup","Apri la cartella dei backup","Aggiungi il contenuto condiviso a…","Annulla"],
	"pt-BR": ["Tema","Paleta","Pasta de plugins personalizada","Pasta de configuração","Abrir a pasta de configuração","Pasta de backups","Abrir a pasta de backups","Adicionar o conteúdo compartilhado a…","Cancelar"],
	"pt-PT": ["Tema","Paleta","Pasta de plugins personalizada","Pasta de configuração","Abrir a pasta de configuração","Pasta de cópias de segurança","Abrir a pasta de cópias de segurança","Adicionar o conteúdo partilhado a…","Cancelar"],
	"nl-NL": ["Thema","Palet","Aangepaste plug-inmap","Configuratiemap","Configuratiemap openen","Back-upmap","Back-upmap openen","Gedeelde inhoud toevoegen aan…","Annuleren"],
	"da-DK": ["Tema","Palet","Tilpasset plugin-mappe","Konfigurationsmappe","Åbn konfigurationsmappe","Sikkerhedskopimappe","Åbn sikkerhedskopimappe","Tilføj delt indhold til…","Annuller"],
	"sv-SE": ["Tema","Palett","Anpassad tilläggsmapp","Konfigurationsmapp","Öppna konfigurationsmapp","Säkerhetskopieringsmapp","Öppna säkerhetskopieringsmapp","Lägg till delat innehåll i…","Avbryt"],
	"pl-PL": ["Motyw","Paleta","Własny folder wtyczek","Folder konfiguracji","Otwórz folder konfiguracji","Folder kopii zapasowych","Otwórz folder kopii zapasowych","Dodaj udostępnioną treść do…","Anuluj"],
	"cs-CZ": ["Motiv","Paleta","Vlastní složka zásuvných modulů","Složka konfigurace","Otevřít složku konfigurace","Složka záloh","Otevřít složku záloh","Přidat sdílený obsah do…","Zrušit"],
	"sk-SK": ["Motív","Paleta","Vlastný priečinok pluginov","Priečinok konfigurácie","Otvoriť priečinok konfigurácie","Priečinok záloh","Otvoriť priečinok záloh","Pridať zdieľaný obsah do…","Zrušiť"],
	"sl-SI": ["Tema","Paleta","Mapa dodatkov po meri","Konfiguracijska mapa","Odpri konfiguracijsko mapo","Mapa varnostnih kopij","Odpri mapo varnostnih kopij","Dodaj deljeno vsebino v…","Prekliči"],
	"mk-MK": ["Тема","Палета","Прилагодена папка со приклучоци","Папка со поставки","Отвори ја папката со поставки","Папка со резерви","Отвори ја папката со резерви","Додај ја споделената содржина во…","Откажи"],
	"ru-RU": ["Тема","Палитра","Своя папка плагинов","Папка настроек","Открыть папку настроек","Папка резервных копий","Открыть папку резервных копий","Добавить общий контент в…","Отмена"],
	"el-GR": ["Θέμα","Παλέτα","Προσαρμοσμένος φάκελος προσθέτων","Φάκελος ρυθμίσεων","Άνοιγμα φακέλου ρυθμίσεων","Φάκελος αντιγράφων ασφαλείας","Άνοιγμα φακέλου αντιγράφων ασφαλείας","Προσθήκη κοινόχρηστου περιεχομένου σε…","Άκυρο"],
	"he-IL": ["ערכת נושא","פלטה","תיקיית תוספים מותאמת","תיקיית הגדרות","פתח תיקיית הגדרות","תיקיית גיבויים","פתח תיקיית גיבויים","הוסף תוכן משותף אל…","ביטול"],
	"ar-PS": ["السمة","لوحة الألوان","مجلد إضافات مخصص","مجلد الإعدادات","فتح مجلد الإعدادات","مجلد النسخ الاحتياطية","فتح مجلد النسخ الاحتياطية","أضف المحتوى المشترك إلى…","إلغاء"],
	"fa-IR": ["پوسته","پالت","پوشهٔ افزونهٔ سفارشی","پوشهٔ پیکربندی","باز کردن پوشهٔ پیکربندی","پوشهٔ پشتیبان","باز کردن پوشهٔ پشتیبان","افزودن محتوای هم‌رسانی‌شده به…","لغو"],
	"hi-IN": ["थीम","पैलेट","कस्टम प्लगइन फ़ोल्डर","कॉन्फ़िग फ़ोल्डर","कॉन्फ़िग फ़ोल्डर खोलें","बैकअप फ़ोल्डर","बैकअप फ़ोल्डर खोलें","साझा सामग्री यहाँ जोड़ें…","रद्द करें"],
	"pa-IN": ["ਥੀਮ","ਪੈਲੇਟ","ਕਸਟਮ ਪਲੱਗਇਨ ਫੋਲਡਰ","ਸੰਰਚਨਾ ਫੋਲਡਰ","ਸੰਰਚਨਾ ਫੋਲਡਰ ਖੋਲ੍ਹੋ","ਬੈਕਅੱਪ ਫੋਲਡਰ","ਬੈਕਅੱਪ ਫੋਲਡਰ ਖੋਲ੍ਹੋ","ਸਾਂਝੀ ਸਮੱਗਰੀ ਇੱਥੇ ਸ਼ਾਮਲ ਕਰੋ…","ਰੱਦ ਕਰੋ"],
	"ia-IA": ["Thema","Paletta","Dossier de plugins personalisate","Dossier de configuration","Aperir le dossier de configuration","Dossier de copias de reserva","Aperir le dossier de copias de reserva","Adder le contento compartite a…","Cancellar"],
	"ja-JP": ["テーマ","パレット","カスタムプラグインフォルダー","設定フォルダー","設定フォルダーを開く","バックアップフォルダー","バックアップフォルダーを開く","共有内容の追加先…","キャンセル"],
	"ko-KR": ["테마","팔레트","사용자 지정 플러그인 폴더","설정 폴더","설정 폴더 열기","백업 폴더","백업 폴더 열기","공유된 콘텐츠를 추가할 위키…","취소"],
	"zh-Hans": ["主题","调色板","自定义插件文件夹","配置文件夹","打开配置文件夹","备份文件夹","打开备份文件夹","将共享内容添加到…","取消"],
	"zh-Hant": ["佈景主題","調色盤","自訂外掛資料夾","設定資料夾","開啟設定資料夾","備份資料夾","開啟備份資料夾","將分享內容加入…","取消"]
};
Object.keys(ANDROID).forEach(function(lang) {
	if(!T[lang]) { return; }
	var v = ANDROID[lang];
	T[lang]["Toolbar/ThemeLabel"] = v[0];
	T[lang]["Toolbar/PaletteLabel"] = v[1];
	T[lang]["Toolbar/CustomPluginFolder"] = v[2];
	T[lang]["Toolbar/ConfigFolder"] = v[3];
	T[lang]["Toolbar/OpenConfigFolder"] = v[4];
	T[lang]["Toolbar/BackupFolder"] = v[5];
	T[lang]["Toolbar/OpenBackupFolder"] = v[6];
	T[lang]["Share/Heading"] = v[7];
	T[lang]["Share/Cancel"] = v[8];
});

// Android WikiList list-view chooser (full vs compact rows). Keys: [ViewLabel, ViewFull, ViewCompact].
// Chinese/German variants inherit these via the aliases below.
var VIEW = {
	"de-DE": ["Listenansicht","Vollständig","Kompakt"],
	"fr-FR": ["Vue liste","Complète","Compacte"],
	"es-ES": ["Vista de lista","Completa","Compacta"],
	"ca-ES": ["Vista de llista","Complet","Compacte"],
	"it-IT": ["Vista elenco","Completa","Compatta"],
	"pt-BR": ["Visualização em lista","Completa","Compacta"],
	"pt-PT": ["Vista de lista","Completa","Compacta"],
	"nl-NL": ["Lijstweergave","Volledig","Compact"],
	"da-DK": ["Listevisning","Fuld","Kompakt"],
	"sv-SE": ["Listvy","Fullständig","Kompakt"],
	"pl-PL": ["Widok listy","Pełny","Kompaktowy"],
	"cs-CZ": ["Zobrazení seznamu","Úplné","Kompaktní"],
	"sk-SK": ["Zobrazenie zoznamu","Úplné","Kompaktné"],
	"sl-SI": ["Prikaz seznama","Polno","Strnjeno"],
	"mk-MK": ["Приказ на листа","Целосен","Компактен"],
	"ru-RU": ["Вид списка","Полный","Компактный"],
	"el-GR": ["Προβολή λίστας","Πλήρης","Συμπαγής"],
	"he-IL": ["תצוגת רשימה","מלא","קומפקטי"],
	"ar-PS": ["عرض القائمة","كامل","مُصغّر"],
	"fa-IR": ["نمای فهرست","کامل","فشرده"],
	"hi-IN": ["सूची दृश्य","पूर्ण","संक्षिप्त"],
	"pa-IN": ["ਸੂਚੀ ਦ੍ਰਿਸ਼","ਪੂਰਾ","ਸੰਖੇਪ"],
	"ia-IA": ["Vista de lista","Complete","Compacte"],
	"ja-JP": ["リスト表示","フル","コンパクト"],
	"ko-KR": ["목록 보기","전체","간략"],
	"zh-Hans": ["列表视图","完整","紧凑"],
	"zh-Hant": ["列表檢視","完整","精簡"]
};
Object.keys(VIEW).forEach(function(lang) {
	if(!T[lang]) { return; }
	var v = VIEW[lang];
	T[lang]["Toolbar/ViewLabel"] = v[0];
	T[lang]["Toolbar/ViewFull"] = v[1];
	T[lang]["Toolbar/ViewCompact"] = v[2];
});

// Share-Templates + Backups settings help (Android WikiList). Order:
// [TemplatesHeading, TemplatesHelp, DeleteTemplate, TagsLabel, AddHeading, AddHelp,
//  NamePlaceholder, CreateTemplate, RulesHeading, RulesHelp, RulePlaceholder, BackupsHelp]
var SHARE_SETTINGS = {
	"de-DE": ["Freigabe-Vorlagen","Wenn du einen Link in ein Wiki teilst, reichert TiddlyDesktop ihn an (Titel, Beschreibung, Bild, Einbettung) und erstellt aus der passenden Vorlage unten einen Tiddler. Platzhalter:","Diese Vorlage löschen","Schlagwörter:","Eigene Vorlage hinzufügen","Gib ihr einen Namen (um sie über eine Domänenregel unten anzusprechen) und bearbeite dann oben ihren Inhalt. Sie beginnt als Kopie der generischen Vorlage.","z. B. mastodon","Vorlage erstellen","Domänenregeln","Eine Regel pro Zeile als <code>domain=kind</code> (z. B. <code>vimeo.com=youtube</code> oder <code>mastodon.social=mastodon</code> für eine oben hinzugefügte Vorlage), um eine Website einer bestimmten Vorlage zuzuordnen.","vimeo.com=youtube","Sicherungen von Einzeldatei-Wikis werden standardmäßig neben jedem Wiki gespeichert. Wähle hier einen Ordner, um stattdessen alle Sicherungen an einem Ort zu sammeln."],
	"fr-FR": ["Modèles de partage","Lorsque vous partagez un lien dans un wiki, TiddlyDesktop l'enrichit (titre, description, image, intégration) et crée un tiddler à partir du modèle correspondant ci-dessous. Espaces réservés :","Supprimer ce modèle","Étiquettes :","Ajouter votre propre modèle","Donnez-lui un nom (pour le cibler depuis une règle de domaine ci-dessous), puis modifiez son contenu ci-dessus. Il démarre comme une copie du modèle générique.","p. ex. mastodon","Créer le modèle","Règles de domaine","Une règle par ligne sous la forme <code>domain=kind</code> (p. ex. <code>vimeo.com=youtube</code>, ou <code>mastodon.social=mastodon</code> pour un modèle ajouté ci-dessus) pour associer un site à un modèle particulier.","vimeo.com=youtube","Les sauvegardes des wikis mono-fichier sont écrites à côté de chaque wiki par défaut. Choisissez un dossier ici pour regrouper toutes les sauvegardes au même endroit."],
	"es-ES": ["Plantillas de compartición","Cuando compartes un enlace en un wiki, TiddlyDesktop lo enriquece (título, descripción, imagen, incrustación) y crea un tiddler a partir de la plantilla coincidente de abajo. Marcadores:","Eliminar esta plantilla","Etiquetas:","Añade tu propia plantilla","Ponle un nombre (para apuntarla desde una regla de dominio de abajo) y luego edita su contenido arriba. Empieza como una copia de la plantilla genérica.","p. ej. mastodon","Crear plantilla","Reglas de dominio","Una regla por línea como <code>domain=kind</code> (p. ej. <code>vimeo.com=youtube</code>, o <code>mastodon.social=mastodon</code> para una plantilla que hayas añadido arriba) para dirigir un sitio a una plantilla concreta.","vimeo.com=youtube","Las copias de seguridad de los wikis de archivo único se guardan junto a cada wiki de forma predeterminada. Elige aquí una carpeta para reunir todas las copias en un solo lugar."],
	"it-IT": ["Modelli di condivisione","Quando condividi un link in un wiki, TiddlyDesktop lo arricchisce (titolo, descrizione, immagine, incorporamento) e crea un tiddler dal modello corrispondente qui sotto. Segnaposti:","Elimina questo modello","Tag:","Aggiungi il tuo modello","Dagli un nome (per richiamarlo da una regola di dominio qui sotto), poi modifica il suo contenuto sopra. Parte come copia del modello generico.","es. mastodon","Crea modello","Regole di dominio","Una regola per riga come <code>domain=kind</code> (es. <code>vimeo.com=youtube</code>, oppure <code>mastodon.social=mastodon</code> per un modello aggiunto sopra) per indirizzare un sito a un modello specifico.","vimeo.com=youtube","I backup dei wiki a file singolo vengono salvati accanto a ciascun wiki per impostazione predefinita. Scegli qui una cartella per raccogliere tutti i backup in un unico posto."],
	"pt-PT": ["Modelos de partilha","Quando partilha uma ligação num wiki, o TiddlyDesktop enriquece-a (título, descrição, imagem, incorporação) e cria um tiddler a partir do modelo correspondente abaixo. Marcadores:","Eliminar este modelo","Etiquetas:","Adicione o seu próprio modelo","Dê-lhe um nome (para o referenciar a partir de uma regra de domínio abaixo) e depois edite o seu conteúdo acima. Começa como uma cópia do modelo genérico.","p. ex. mastodon","Criar modelo","Regras de domínio","Uma regra por linha como <code>domain=kind</code> (p. ex. <code>vimeo.com=youtube</code>, ou <code>mastodon.social=mastodon</code> para um modelo que adicionou acima) para encaminhar um site para um modelo específico.","vimeo.com=youtube","As cópias de segurança de wikis de ficheiro único são guardadas junto a cada wiki por predefinição. Escolha aqui uma pasta para reunir todas as cópias num só local."],
	"pt-BR": ["Modelos de compartilhamento","Quando você compartilha um link em um wiki, o TiddlyDesktop o enriquece (título, descrição, imagem, incorporação) e cria um tiddler a partir do modelo correspondente abaixo. Espaços reservados:","Excluir este modelo","Tags:","Adicione seu próprio modelo","Dê um nome a ele (para referenciá-lo a partir de uma regra de domínio abaixo) e edite seu conteúdo acima. Ele começa como uma cópia do modelo genérico.","ex. mastodon","Criar modelo","Regras de domínio","Uma regra por linha como <code>domain=kind</code> (ex. <code>vimeo.com=youtube</code>, ou <code>mastodon.social=mastodon</code> para um modelo que você adicionou acima) para direcionar um site para um modelo específico.","vimeo.com=youtube","Os backups de wikis de arquivo único são gravados ao lado de cada wiki por padrão. Escolha uma pasta aqui para reunir todos os backups em um só lugar."],
	"nl-NL": ["Deelsjablonen","Wanneer je een link in een wiki deelt, verrijkt TiddlyDesktop deze (titel, beschrijving, afbeelding, insluiting) en bouwt een tiddler op basis van het overeenkomende sjabloon hieronder. Plaatsaanduidingen:","Dit sjabloon verwijderen","Labels:","Eigen sjabloon toevoegen","Geef het een naam (om het aan te sturen vanuit een domeinregel hieronder) en bewerk vervolgens de inhoud hierboven. Het begint als een kopie van het generieke sjabloon.","bijv. mastodon","Sjabloon maken","Domeinregels","Eén regel per regel als <code>domain=kind</code> (bijv. <code>vimeo.com=youtube</code>, of <code>mastodon.social=mastodon</code> voor een sjabloon dat je hierboven hebt toegevoegd) om een site naar een bepaald sjabloon te leiden.","vimeo.com=youtube","Back-ups van enkelbestandswiki's worden standaard naast elke wiki opgeslagen. Kies hier een map om in plaats daarvan alle back-ups op één plek te verzamelen."],
	"pl-PL": ["Szablony udostępniania","Gdy udostępniasz link do wiki, TiddlyDesktop wzbogaca go (tytuł, opis, obraz, osadzenie) i tworzy tiddlera z pasującego szablonu poniżej. Symbole zastępcze:","Usuń ten szablon","Tagi:","Dodaj własny szablon","Nadaj mu nazwę (aby wskazać go z reguły domeny poniżej), a następnie edytuj jego treść powyżej. Zaczyna jako kopia szablonu ogólnego.","np. mastodon","Utwórz szablon","Reguły domen","Jedna reguła w wierszu jako <code>domain=kind</code> (np. <code>vimeo.com=youtube</code> lub <code>mastodon.social=mastodon</code> dla szablonu dodanego powyżej), aby kierować witrynę do konkretnego szablonu.","vimeo.com=youtube","Kopie zapasowe wiki jednoplikowych są domyślnie zapisywane obok każdej wiki. Wybierz tutaj folder, aby zamiast tego zebrać wszystkie kopie w jednym miejscu."],
	"ru-RU": ["Шаблоны публикации","Когда вы делитесь ссылкой в вики, TiddlyDesktop обогащает её (заголовок, описание, изображение, встраивание) и создаёт тиддлер из подходящего шаблона ниже. Заполнители:","Удалить этот шаблон","Метки:","Добавьте свой шаблон","Дайте ему имя (чтобы указать на него из правила домена ниже), затем отредактируйте его содержимое выше. Он начинается как копия универсального шаблона.","напр. mastodon","Создать шаблон","Правила доменов","Одно правило на строку в виде <code>domain=kind</code> (напр. <code>vimeo.com=youtube</code> или <code>mastodon.social=mastodon</code> для добавленного выше шаблона), чтобы направить сайт к определённому шаблону.","vimeo.com=youtube","Резервные копии одностраничных вики по умолчанию сохраняются рядом с каждой вики. Выберите здесь папку, чтобы вместо этого собрать все копии в одном месте."],
	"sv-SE": ["Delningsmallar","När du delar en länk till en wiki berikar TiddlyDesktop den (titel, beskrivning, bild, inbäddning) och bygger en tiddler från den matchande mallen nedan. Platshållare:","Ta bort den här mallen","Taggar:","Lägg till din egen mall","Ge den ett namn (för att rikta in den från en domänregel nedan) och redigera sedan dess innehåll ovan. Den börjar som en kopia av den generiska mallen.","t.ex. mastodon","Skapa mall","Domänregler","En regel per rad som <code>domain=kind</code> (t.ex. <code>vimeo.com=youtube</code>, eller <code>mastodon.social=mastodon</code> för en mall du lagt till ovan) för att styra en webbplats till en viss mall.","vimeo.com=youtube","Säkerhetskopior av enfilswikis skrivs som standard bredvid varje wiki. Välj en mapp här för att i stället samla alla säkerhetskopior på ett ställe."],
	"da-DK": ["Delingsskabeloner","Når du deler et link i en wiki, beriger TiddlyDesktop det (titel, beskrivelse, billede, indlejring) og bygger en tiddler ud fra den matchende skabelon nedenfor. Pladsholdere:","Slet denne skabelon","Mærker:","Tilføj din egen skabelon","Giv den et navn (for at målrette den fra en domæneregel nedenfor), og rediger derefter dens indhold ovenfor. Den starter som en kopi af den generiske skabelon.","f.eks. mastodon","Opret skabelon","Domæneregler","Én regel pr. linje som <code>domain=kind</code> (f.eks. <code>vimeo.com=youtube</code>, eller <code>mastodon.social=mastodon</code> for en skabelon, du har tilføjet ovenfor) for at dirigere et websted til en bestemt skabelon.","vimeo.com=youtube","Sikkerhedskopier af enkeltfil-wikier skrives som standard ved siden af hver wiki. Vælg en mappe her for i stedet at samle alle sikkerhedskopier ét sted."],
	"cs-CZ": ["Šablony sdílení","Když sdílíte odkaz do wiki, TiddlyDesktop jej obohatí (název, popis, obrázek, vložení) a vytvoří tiddler z odpovídající šablony níže. Zástupné symboly:","Smazat tuto šablonu","Štítky:","Přidejte vlastní šablonu","Pojmenujte ji (abyste na ni cílili z pravidla domény níže) a poté upravte její obsah výše. Začíná jako kopie obecné šablony.","např. mastodon","Vytvořit šablonu","Pravidla domén","Jedno pravidlo na řádek jako <code>domain=kind</code> (např. <code>vimeo.com=youtube</code> nebo <code>mastodon.social=mastodon</code> pro šablonu přidanou výše) pro nasměrování webu na konkrétní šablonu.","vimeo.com=youtube","Zálohy jednosouborových wiki se ve výchozím nastavení ukládají vedle každé wiki. Zde vyberte složku, abyste místo toho shromáždili všechny zálohy na jednom místě."],
	"sk-SK": ["Šablóny zdieľania","Keď zdieľate odkaz do wiki, TiddlyDesktop ho obohatí (názov, popis, obrázok, vloženie) a vytvorí tiddler z príslušnej šablóny nižšie. Zástupné symboly:","Odstrániť túto šablónu","Značky:","Pridajte vlastnú šablónu","Dajte jej názov (aby ste na ňu cielili z pravidla domény nižšie) a potom upravte jej obsah vyššie. Začína ako kópia všeobecnej šablóny.","napr. mastodon","Vytvoriť šablónu","Pravidlá domén","Jedno pravidlo na riadok ako <code>domain=kind</code> (napr. <code>vimeo.com=youtube</code> alebo <code>mastodon.social=mastodon</code> pre šablónu pridanú vyššie) na nasmerovanie stránky na konkrétnu šablónu.","vimeo.com=youtube","Zálohy jednosúborových wiki sa predvolene ukladajú vedľa každej wiki. Tu vyberte priečinok, aby ste namiesto toho zhromaždili všetky zálohy na jednom mieste."],
	"sl-SI": ["Predloge za deljenje","Ko delite povezavo v wiki, jo TiddlyDesktop obogati (naslov, opis, sliko, vdelavo) in iz ustrezne predloge spodaj ustvari tiddler. Ograde:","Izbriši to predlogo","Oznake:","Dodajte svojo predlogo","Poimenujte jo (za sklicevanje iz pravila domene spodaj), nato pa uredite njeno vsebino zgoraj. Začne kot kopija splošne predloge.","npr. mastodon","Ustvari predlogo","Pravila domen","Eno pravilo na vrstico kot <code>domain=kind</code> (npr. <code>vimeo.com=youtube</code> ali <code>mastodon.social=mastodon</code> za predlogo, dodano zgoraj), da usmerite spletno mesto na določeno predlogo.","vimeo.com=youtube","Varnostne kopije enodatotečnih wikijev se privzeto shranjujejo poleg vsakega wikija. Tukaj izberite mapo, da namesto tega zberete vse varnostne kopije na enem mestu."],
	"el-GR": ["Πρότυπα κοινοποίησης","Όταν κοινοποιείτε έναν σύνδεσμο σε ένα wiki, το TiddlyDesktop τον εμπλουτίζει (τίτλος, περιγραφή, εικόνα, ενσωμάτωση) και δημιουργεί ένα tiddler από το αντίστοιχο πρότυπο παρακάτω. Σύμβολα κράτησης θέσης:","Διαγραφή αυτού του προτύπου","Ετικέτες:","Προσθέστε το δικό σας πρότυπο","Δώστε του ένα όνομα (για να το στοχεύσετε από έναν κανόνα τομέα παρακάτω) και έπειτα επεξεργαστείτε το περιεχόμενό του παραπάνω. Ξεκινά ως αντίγραφο του γενικού προτύπου.","π.χ. mastodon","Δημιουργία προτύπου","Κανόνες τομέα","Ένας κανόνας ανά γραμμή ως <code>domain=kind</code> (π.χ. <code>vimeo.com=youtube</code> ή <code>mastodon.social=mastodon</code> για ένα πρότυπο που προσθέσατε παραπάνω) για να δρομολογήσετε έναν ιστότοπο σε ένα συγκεκριμένο πρότυπο.","vimeo.com=youtube","Τα αντίγραφα ασφαλείας των wiki ενός αρχείου γράφονται από προεπιλογή δίπλα σε κάθε wiki. Επιλέξτε έναν φάκελο εδώ για να συγκεντρώσετε όλα τα αντίγραφα ασφαλείας σε ένα μέρος."],
	"ca-ES": ["Plantilles de compartició","Quan comparteixes un enllaç en un wiki, TiddlyDesktop l'enriqueix (títol, descripció, imatge, incrustació) i crea un tiddler a partir de la plantilla coincident de sota. Marcadors de posició:","Elimina aquesta plantilla","Etiquetes:","Afegeix la teva pròpia plantilla","Posa-li un nom (per orientar-la des d'una regla de domini a sota) i després edita'n el contingut a dalt. Comença com una còpia de la plantilla genèrica.","p. ex. mastodon","Crea la plantilla","Regles de domini","Una regla per línia com <code>domain=kind</code> (p. ex. <code>vimeo.com=youtube</code>, o <code>mastodon.social=mastodon</code> per a una plantilla que hagis afegit a dalt) per dirigir un lloc a una plantilla concreta.","vimeo.com=youtube","Les còpies de seguretat dels wikis d'un sol fitxer s'escriuen al costat de cada wiki de manera predeterminada. Tria una carpeta aquí per recollir totes les còpies en un sol lloc."],
	"ar-PS": ["قوالب المشاركة","عند مشاركة رابط في ويكي، يقوم TiddlyDesktop بإثرائه (العنوان، الوصف، الصورة، التضمين) وينشئ تيدلر من القالب المطابق أدناه. العناصر النائبة:","حذف هذا القالب","الوسوم:","أضف قالبك الخاص","امنحه اسمًا (لاستهدافه من قاعدة نطاق أدناه)، ثم عدّل محتواه أعلاه. يبدأ كنسخة من القالب العام.","مثال: mastodon","إنشاء قالب","قواعد النطاق","قاعدة واحدة في كل سطر بالشكل <code>domain=kind</code> (مثل <code>vimeo.com=youtube</code>، أو <code>mastodon.social=mastodon</code> لقالب أضفته أعلاه) لتوجيه موقع إلى قالب معيّن.","vimeo.com=youtube","تُكتب النسخ الاحتياطية لويكيات الملف الواحد بجانب كل ويكي افتراضيًا. اختر مجلدًا هنا لتجميع كل النسخ الاحتياطية في مكان واحد بدلاً من ذلك."],
	"fa-IR": ["قالب‌های هم‌رسانی","وقتی پیوندی را در یک ویکی هم‌رسانی می‌کنید، TiddlyDesktop آن را غنی می‌کند (عنوان، توضیح، تصویر، جاسازی) و از قالب منطبق زیر یک تیدلر می‌سازد. جای‌گیرها:","حذف این قالب","برچسب‌ها:","قالب خود را اضافه کنید","به آن نامی بدهید (برای هدف‌گیری از یک قاعدهٔ دامنه در زیر)، سپس محتوای آن را در بالا ویرایش کنید. به‌صورت یک نسخه از قالب عمومی آغاز می‌شود.","مثلاً mastodon","ساخت قالب","قواعد دامنه","هر خط یک قاعده به شکل <code>domain=kind</code> (مثلاً <code>vimeo.com=youtube</code> یا <code>mastodon.social=mastodon</code> برای قالبی که در بالا افزوده‌اید) برای هدایت یک سایت به قالبی خاص.","vimeo.com=youtube","نسخه‌های پشتیبان ویکی‌های تک‌پرونده‌ای به‌طور پیش‌فرض کنار هر ویکی نوشته می‌شوند. اینجا پوشه‌ای انتخاب کنید تا به‌جای آن همهٔ نسخه‌های پشتیبان در یک مکان جمع شوند."],
	"he-IL": ["תבניות שיתוף","כאשר אתה משתף קישור לוויקי, TiddlyDesktop מעשיר אותו (כותרת, תיאור, תמונה, הטמעה) ובונה טידלר מהתבנית התואמת שלמטה. מצייני מיקום:","מחק תבנית זו","תגיות:","הוסף תבנית משלך","תן לה שם (כדי לכוון אליה מכלל דומיין למטה), ואז ערוך את תוכנה למעלה. היא מתחילה כעותק של התבנית הכללית.","לדוגמה mastodon","צור תבנית","כללי דומיין","כלל אחד בכל שורה בצורה <code>domain=kind</code> (לדוגמה <code>vimeo.com=youtube</code>, או <code>mastodon.social=mastodon</code> עבור תבנית שהוספת למעלה) כדי לנתב אתר לתבנית מסוימת.","vimeo.com=youtube","גיבויים של ויקי בקובץ יחיד נכתבים לצד כל ויקי כברירת מחדל. בחר כאן תיקייה כדי לאסוף את כל הגיבויים במקום אחד במקום זאת."],
	"hi-IN": ["साझा टेम्पलेट","जब आप किसी विकी में लिंक साझा करते हैं, तो TiddlyDesktop उसे समृद्ध करता है (शीर्षक, विवरण, छवि, एम्बेड) और नीचे मिलान वाले टेम्पलेट से एक टिडलर बनाता है। प्लेसहोल्डर:","यह टेम्पलेट हटाएँ","टैग:","अपना टेम्पलेट जोड़ें","इसे एक नाम दें (नीचे किसी डोमेन नियम से इसे लक्षित करने के लिए), फिर ऊपर इसकी सामग्री संपादित करें। यह सामान्य टेम्पलेट की प्रति के रूप में शुरू होता है।","जैसे mastodon","टेम्पलेट बनाएँ","डोमेन नियम","प्रति पंक्ति एक नियम <code>domain=kind</code> के रूप में (जैसे <code>vimeo.com=youtube</code>, या ऊपर जोड़े गए टेम्पलेट के लिए <code>mastodon.social=mastodon</code>) किसी साइट को किसी विशेष टेम्पलेट पर भेजने के लिए।","vimeo.com=youtube","एकल-फ़ाइल विकी के बैकअप डिफ़ॉल्ट रूप से प्रत्येक विकी के साथ लिखे जाते हैं। इसके बजाय सभी बैकअप एक स्थान पर एकत्र करने के लिए यहाँ एक फ़ोल्डर चुनें।"],
	"pa-IN": ["ਸਾਂਝੇ ਟੈਂਪਲੇਟ","ਜਦੋਂ ਤੁਸੀਂ ਕਿਸੇ ਵਿਕੀ ਵਿੱਚ ਲਿੰਕ ਸਾਂਝਾ ਕਰਦੇ ਹੋ, ਤਾਂ TiddlyDesktop ਇਸਨੂੰ ਭਰਪੂਰ ਕਰਦਾ ਹੈ (ਸਿਰਲੇਖ, ਵੇਰਵਾ, ਚਿੱਤਰ, ਏਮਬੈੱਡ) ਅਤੇ ਹੇਠਾਂ ਮੇਲ ਖਾਂਦੇ ਟੈਂਪਲੇਟ ਤੋਂ ਇੱਕ ਟਿਡਲਰ ਬਣਾਉਂਦਾ ਹੈ। ਪਲੇਸਹੋਲਡਰ:","ਇਹ ਟੈਂਪਲੇਟ ਮਿਟਾਓ","ਟੈਗ:","ਆਪਣਾ ਟੈਂਪਲੇਟ ਸ਼ਾਮਲ ਕਰੋ","ਇਸਨੂੰ ਇੱਕ ਨਾਮ ਦਿਓ (ਹੇਠਾਂ ਕਿਸੇ ਡੋਮੇਨ ਨਿਯਮ ਤੋਂ ਇਸਨੂੰ ਨਿਸ਼ਾਨਾ ਬਣਾਉਣ ਲਈ), ਫਿਰ ਉੱਪਰ ਇਸਦੀ ਸਮੱਗਰੀ ਸੰਪਾਦਿਤ ਕਰੋ। ਇਹ ਆਮ ਟੈਂਪਲੇਟ ਦੀ ਕਾਪੀ ਵਜੋਂ ਸ਼ੁਰੂ ਹੁੰਦਾ ਹੈ।","ਜਿਵੇਂ mastodon","ਟੈਂਪਲੇਟ ਬਣਾਓ","ਡੋਮੇਨ ਨਿਯਮ","ਪ੍ਰਤੀ ਲਾਈਨ ਇੱਕ ਨਿਯਮ <code>domain=kind</code> ਵਜੋਂ (ਜਿਵੇਂ <code>vimeo.com=youtube</code>, ਜਾਂ ਉੱਪਰ ਸ਼ਾਮਲ ਕੀਤੇ ਟੈਂਪਲੇਟ ਲਈ <code>mastodon.social=mastodon</code>) ਕਿਸੇ ਸਾਈਟ ਨੂੰ ਕਿਸੇ ਖਾਸ ਟੈਂਪਲੇਟ ਵੱਲ ਭੇਜਣ ਲਈ।","vimeo.com=youtube","ਇਕਹਿਰੀ-ਫਾਈਲ ਵਿਕੀ ਦੇ ਬੈਕਅੱਪ ਮੂਲ ਰੂਪ ਵਿੱਚ ਹਰ ਵਿਕੀ ਦੇ ਨਾਲ ਲਿਖੇ ਜਾਂਦੇ ਹਨ। ਇਸਦੀ ਬਜਾਏ ਸਾਰੇ ਬੈਕਅੱਪ ਇੱਕ ਥਾਂ ਇਕੱਠੇ ਕਰਨ ਲਈ ਇੱਥੇ ਇੱਕ ਫੋਲਡਰ ਚੁਣੋ।"],
	"ia-IA": ["Modellos de compartir","Quando tu comparti un ligamine in un wiki, TiddlyDesktop lo inricchi (titulo, description, imagine, incorporation) e construe un tiddler ex le modello concordante infra. Substitutos:","Deler iste modello","Etiquettas:","Adde tu proprie modello","Da lo un nomine (pro appellar lo ab un regula de dominio infra), pois redige su contento supra. Illo comencia como un copia del modello generic.","p.ex. mastodon","Crear modello","Regulas de dominio","Un regula per linea como <code>domain=kind</code> (p.ex. <code>vimeo.com=youtube</code>, o <code>mastodon.social=mastodon</code> pro un modello que tu addeva supra) pro diriger un sito a un modello specific.","vimeo.com=youtube","Le copias de reserva de wikis de file unic es scribite juxta cata wiki per predefecto. Selige un dossier hic pro colliger in loco tote le copias de reserva in un sol loco."],
	"ja-JP": ["共有テンプレート","ウィキにリンクを共有すると、TiddlyDesktop はそれを補強し（タイトル、説明、画像、埋め込み）、下の一致するテンプレートからティドラーを作成します。プレースホルダー:","このテンプレートを削除","タグ:","独自のテンプレートを追加","名前を付け（下のドメイン規則から指定するため）、上でその本文を編集します。汎用テンプレートのコピーとして始まります。","例: mastodon","テンプレートを作成","ドメイン規則","1 行に 1 つの規則を <code>domain=kind</code> の形式で（例: <code>vimeo.com=youtube</code>、または上で追加したテンプレート用に <code>mastodon.social=mastodon</code>）記述し、サイトを特定のテンプレートに振り分けます。","vimeo.com=youtube","単一ファイルウィキのバックアップは、既定では各ウィキの隣に書き込まれます。代わりにすべてのバックアップを 1 か所にまとめるには、ここでフォルダーを選択してください。"],
	"ko-KR": ["공유 템플릿","위키에 링크를 공유하면 TiddlyDesktop이 이를 보강하고(제목, 설명, 이미지, 임베드) 아래의 일치하는 템플릿에서 티들러를 만듭니다. 자리 표시자:","이 템플릿 삭제","태그:","나만의 템플릿 추가","이름을 지정하고(아래 도메인 규칙에서 대상으로 지정하기 위해) 위에서 본문을 편집하세요. 일반 템플릿의 복사본으로 시작합니다.","예: mastodon","템플릿 만들기","도메인 규칙","사이트를 특정 템플릿으로 라우팅하려면 한 줄에 하나씩 <code>domain=kind</code> 형식으로 규칙을 작성하세요(예: <code>vimeo.com=youtube</code> 또는 위에서 추가한 템플릿의 경우 <code>mastodon.social=mastodon</code>).","vimeo.com=youtube","단일 파일 위키의 백업은 기본적으로 각 위키 옆에 기록됩니다. 대신 모든 백업을 한곳에 모으려면 여기에서 폴더를 선택하세요."],
	"mk-MK": ["Шаблони за споделување","Кога споделувате врска во вики, TiddlyDesktop ја збогатува (наслов, опис, слика, вградување) и создава tiddler од соодветниот шаблон подолу. Резервирани места:","Избриши го овој шаблон","Ознаки:","Додајте свој шаблон","Дајте му име (за да го насочите од правило за домен подолу), потоа уредете ја неговата содржина погоре. Започнува како копија на општиот шаблон.","на пр. mastodon","Создај шаблон","Правила за домени","Едно правило по ред како <code>domain=kind</code> (на пр. <code>vimeo.com=youtube</code>, или <code>mastodon.social=mastodon</code> за шаблон што го додадовте погоре) за да насочите сајт кон одреден шаблон.","vimeo.com=youtube","Резервните копии на вики со една датотека стандардно се запишуваат до секое вики. Изберете папка овде за наместо тоа да ги соберете сите резервни копии на едно место."],
	"zh-Hans": ["分享模板","当你把链接分享到一个 wiki 时，TiddlyDesktop 会对其进行丰富（标题、描述、图片、嵌入），并根据下面匹配的模板生成一个 tiddler。占位符：","删除此模板","标签：","添加你自己的模板","给它取个名字（以便从下面的域名规则中引用它），然后在上方编辑其正文。它以通用模板的副本开始。","例如 mastodon","创建模板","域名规则","每行一条规则，格式为 <code>domain=kind</code>（例如 <code>vimeo.com=youtube</code>，或对于上面添加的模板使用 <code>mastodon.social=mastodon</code>），将某个站点路由到特定模板。","vimeo.com=youtube","单文件 wiki 的备份默认写入在每个 wiki 旁边。在此选择一个文件夹，以便将所有备份集中到一个位置。"],
	"zh-Hant": ["分享範本","當你將連結分享到一個 wiki 時，TiddlyDesktop 會加以豐富（標題、描述、圖片、嵌入），並根據下方相符的範本產生一個 tiddler。預留位置：","刪除此範本","標籤：","新增你自己的範本","為它命名（以便從下方的網域規則參照它），然後在上方編輯其內文。它以通用範本的副本開始。","例如 mastodon","建立範本","網域規則","每行一條規則，格式為 <code>domain=kind</code>（例如 <code>vimeo.com=youtube</code>，或對於上方新增的範本使用 <code>mastodon.social=mastodon</code>），將某個網站導向特定範本。","vimeo.com=youtube","單一檔案 wiki 的備份預設寫入在每個 wiki 旁邊。在此選擇一個資料夾，以便將所有備份集中到一個位置。"]
};
Object.keys(SHARE_SETTINGS).forEach(function(lang) {
	if(!T[lang]) { return; }
	var v = SHARE_SETTINGS[lang], keys = ["Share/TemplatesHeading","Share/TemplatesHelp","Share/DeleteTemplate","Share/TagsLabel","Share/AddHeading","Share/AddHelp","Share/NamePlaceholder","Share/CreateTemplate","Share/RulesHeading","Share/RulesHelp","Share/RulePlaceholder","Advanced/BackupsHelp"];
	keys.forEach(function(k, i) { T[lang][k] = v[i]; });
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
