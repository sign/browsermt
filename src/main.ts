// import * as Comlink from "https://unpkg.com/comlink/dist/esm/comlink.mjs";

const statusEl: HTMLElement = document.querySelector("#status")!;
const displayStatus = (status: string) => (statusEl.innerText = status);

const langFromEl: HTMLSelectElement = document.querySelector("#lang-from")!;
const langToEl: HTMLSelectElement = document.querySelector("#lang-to")!;

const inputEl: HTMLInputElement = document.querySelector("#input")!;
const outputEl: HTMLInputElement = document.querySelector("#output")!;
const swapButtonEl: HTMLButtonElement = document.querySelector(".swap")!;

function _prepareTranslateOptions(paragraphs: string[]) {
  // Each option object can be different for each entry. But to keep the test page simple,
  // we just keep all the options same (specifically avoiding parsing the input to determine
  // html/non-html text)
  return new Array(paragraphs.length).fill({
    isQualityScores: true,
    isHtml: true,
  });
}

function textToHTML(text: string): string {
  const div = document.createElement("div");
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}

async function main() {
  const worker: Worker = new Worker("../../build/esm/worker.js");
  const comlinkWorker = Comlink.wrap(worker);

  await comlinkWorker.importBergamotWorker(
    "../../../artifacts/bergamot-translator-worker.js",
    "../../../artifacts/bergamot-translator-worker.wasm"
  );

  const MODEL_REGISTRY = "../../example/src/models/registry.json";
  const response = await fetch(MODEL_REGISTRY);
  const modelRegistry = await response.json();

  const translateCall = () => {
    const text = inputEl.value;
    if (!text.trim().length) return;

    const paragraphs = text.split(/\n+/).map(textToHTML); // escape HTML
    const translateOptions = _prepareTranslateOptions(paragraphs);
    const lngFrom = langFromEl.value;
    const lngTo = langToEl.value;
    worker.postMessage([
      "translate",
      lngFrom,
      lngTo,
      paragraphs,
      translateOptions,
    ]);
  };

  const addQualityClasses = (root: HTMLElement) => {
    // You can do this wit CSS variables, calc() and min/max, but JS is just easier

    root.querySelectorAll("[x-bergamot-sentence-score]").forEach((el) => {
      // The threshold is ln(0.5) (https://github.com/browsermt/bergamot-translator/pull/370#issuecomment-1058123399)
      const score = el.getAttribute("x-bergamot-sentence-score") ?? "";
      el.classList.toggle("bad", parseFloat(score) < -0.6931);
    });

    root.querySelectorAll("[x-bergamot-word-score]").forEach((el) => {
      // The threshold is ln(0.5) (https://github.com/browsermt/bergamot-translator/pull/370#issuecomment-1058123399)
      const score = el.getAttribute("x-bergamot-word-score") ?? "";
      el.classList.toggle("bad", parseFloat(score) < -0.6931);
    });

    // Add tooltips to each (sub)word with sentence and word score.
    root
      .querySelectorAll("[x-bergamot-sentence-score] > [x-bergamot-word-score]")
      .forEach((el) => {
        const parent = el.parentNode as HTMLElement;
        const sentenceScore = parseFloat(
          parent.getAttribute("x-bergamot-sentence-score") ?? ""
        );
        const wordScore = parseFloat(
          el.getAttribute("x-bergamot-word-score") ?? ""
        );
        el.setAttribute(
          "title",
          `Sentence: ${sentenceScore}  Word: ${wordScore}`
        );
      });
  };

  worker.onmessage = function (e) {
    if (e.data[0] === "translate_reply" && e.data[1]) {
      // Clear output of previous translation
      outputEl.innerHTML = "";

      // Add each translation in its own div to have a known root in which the
      // sentence ids are unique. Used for highlighting sentences.
      e.data[1].forEach((translatedHTML: string) => {
        // TODO move to translate method
        const translation = document.createElement("div");
        translation.classList.add("translation");
        translation.innerHTML = translatedHTML;
        addQualityClasses(translation);
        outputEl.appendChild(translation);
      });
    }
  };

  const loadModel = async () => {
    const lngFrom = langFromEl.value;
    const lngTo = langToEl.value;
    if (lngFrom !== lngTo) {
      displayStatus(`Installing model...`);
      console.log(`Loading model '${lngFrom}${lngTo}'`);
      displayStatus(
        await comlinkWorker.loadModel(lngFrom, lngTo, modelRegistry)
      );
      translateCall();
    } else {
      outputEl.innerHTML = textToHTML(inputEl.value);
    }
  };

  langFromEl.addEventListener("change", loadModel);
  langToEl.addEventListener("change", loadModel);

  swapButtonEl.addEventListener("click", async () => {
    [langFromEl.value, langToEl.value] = [langToEl.value, langFromEl.value];
    inputEl.value = outputEl.innerText;
    await loadModel();
  });

  outputEl.addEventListener("mouseover", (e) => {
    const target = e.target as HTMLElement;
    const parent = target.parentNode as HTMLElement;
    const root = target.closest(".translation");
    const sentence = parent.hasAttribute("x-bergamot-sentence-index")
      ? parent.getAttribute("x-bergamot-sentence-index")
      : null;
    document
      .querySelectorAll("#output font[x-bergamot-sentence-index]")
      .forEach((el) => {
        el.classList.toggle(
          "highlight-sentence",
          el.getAttribute("x-bergamot-sentence-index") === sentence &&
            el.closest(".translation") === root
        );
      });
  });

  async function init() {
    const langs: string[] = Array.from(
      new Set(
        Object.keys(modelRegistry).reduce(
          // @ts-expect-error
          (acc, key) => acc.concat([key.substring(0, 2), key.substring(2, 4)]),
          []
        )
      )
    );
    const langNames = new Intl.DisplayNames(undefined, { type: "language" });
    const langName = (lang: string) => langNames.of(lang) ?? lang;

    // Sort languages by display name
    langs.sort((a, b) => langName(a).localeCompare(langName(b)));

    // Populate the dropdowns
    langs.forEach((code) => {
      const name = langName(code);
      langFromEl.innerHTML += `<option value="${code}">${name}</option>`;
      langToEl.innerHTML += `<option value="${code}">${name}</option>`;
    });

    // try to guess input language from user agent
    let myLang = "navigator" in globalThis ? navigator.language : "";
    if (myLang) {
      myLang = myLang.split("-")[0];
      if (langs.includes(myLang)) {
        console.log("guessing input language is", myLang);
        langFromEl.value = myLang;
      }
    }

    // find first output lang that *isn't* input language
    langToEl.value = langs.find((code) => code !== langFromEl.value)!;

    // load this model
    await loadModel();
  }

  inputEl.addEventListener("keyup", translateCall);

  return init();
}

main()
  .then(() => {
    console.log("ready");
  })
  .catch((err) => console.error(err));