package litesrc

import (
	"context"
	stdjson "encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"lampac-go/internal/proxylink"
)

func filmixTestMedia(track string, duration float64) string {
	return fmt.Sprintf("#EXTM3U\n#EXT-X-TARGETDURATION:12\n#EXTINF:%.3f,\nseg-1-%s.ts\n#EXT-X-ENDLIST\n", duration, track)
}

func TestFilmixAudioTrackURL(t *testing.T) {
	for _, raw := range []string{"https://cdn.test/s/opaque/show_2160.mp4", "https://cdn.test/hls/show_2160.mp4/index.m3u8?hash=opaque"} {
		got, err := filmixAudioTrackURL(raw, "a1")
		if err != nil || got != "https://cdn.test/hls/show_2160.mp4/index-a1.m3u8?hash=opaque" {
			t.Fatalf("unexpected track URL %q, %v", got, err)
		}
	}
	for _, raw := range []string{"file:///etc/passwd", "https://cdn.test/video.mp4", "javascript:example"} {
		if _, err := filmixAudioTrackURL(raw, "a1"); err == nil {
			t.Fatalf("accepted unsupported source %q", raw)
		}
	}
}

func TestFilmixAudioRejectsMuxedAndInvalidPlaylists(t *testing.T) {
	valid := filmixTestMedia("a1", 10)
	if d, err := filmixAudioDuration(valid, "a1"); err != nil || d != 10 {
		t.Fatalf("valid audio rejected: %v", err)
	}
	for _, body := range []string{
		filmixTestMedia("v1-a1", 10), filmixTestMedia("v1", 10),
		strings.ReplaceAll(valid, "#EXT-X-ENDLIST", ""), strings.ReplaceAll(valid, "10.000", "NaN"),
		valid + "seg-2-a1.ts\n", "<html>denied</html>",
	} {
		if _, err := filmixAudioDuration(body, "a1"); err == nil {
			t.Fatalf("accepted invalid playlist %q", body)
		}
	}
}

func TestFilmixAudioMasterContainsRealRenditionsAndRejectsOtherEdit(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("User-Agent") != filmixCDNUserAgent {
			t.Error("CDN user-agent missing")
		}
		duration := 10.0
		track := "a1"
		if strings.HasSuffix(r.URL.Path, "index-v1.m3u8") {
			track = "v1"
		}
		if strings.Contains(r.URL.Path, "other-edit") {
			duration = 12
		}
		_, _ = w.Write([]byte(filmixTestMedia(track, duration)))
	}))
	defer srv.Close()
	j := &filmixAudioJob{client: srv.Client(), video: srv.URL + "/video/index-v1.m3u8", proxyVideo: "https://ours.test/proxy/video.m3u8", sources: []filmixAudioSource{
		{"Selected", srv.URL + "/main/index-a1.m3u8", "https://ours.test/proxy/main.m3u8"},
		{"Other \"voice\"\nname", srv.URL + "/aligned/index-a1.m3u8", "https://ours.test/proxy/other.m3u8"},
		{"Different edit", srv.URL + "/other-edit/index-a1.m3u8", "https://ours.test/proxy/different.m3u8"},
	}}
	if err := j.build(context.Background()); err != nil {
		t.Fatal(err)
	}
	if j.tracks != 2 || strings.Count(j.master, "#EXT-X-MEDIA:TYPE=AUDIO") != 2 || !strings.Contains(j.master, "AUDIO=\"voices\"") {
		t.Fatalf("bad master: %s", j.master)
	}
	if strings.Contains(j.master, "different.m3u8") || strings.Contains(j.master, "name\n") {
		t.Fatalf("unsafe/mismatched rendition: %s", j.master)
	}
	before := calls.Load()
	if err := j.build(context.Background()); err != nil || calls.Load() != before {
		t.Fatal("cached master fetched again")
	}
}

func TestFilmixAudioAPIAndLazyNextEpisode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		track := "a1"
		if strings.HasSuffix(r.URL.Path, "index-v1.m3u8") {
			track = "v1"
		}
		_, _ = w.Write([]byte(filmixTestMedia(track, 10)))
	}))
	defer srv.Close()
	checker := &filmixChecker{client: srv.Client(), token: "test"}
	checker.tokenRights.Store("test", filmixTokenRights{true, time.Now().Add(time.Hour)})
	root := filmixPostRoot{PlayerLinks: &filmixPlayerLinks{Playlist: map[string]map[string]stdjson.RawMessage{"1": {}}}}
	for _, name := range []string{"Amedia", "LostFilm"} {
		data, _ := stdjson.Marshal(map[string]filmixEpisodeItem{
			"3": {Link: srv.URL + "/s/signed/" + name + "3_%s.mp4", Qualities: filmixIntSlice{1080, 2160, 720}},
			"4": {Link: srv.URL + "/s/signed/" + name + "4_%s.mp4", Qualities: filmixIntSlice{1080, 2160, 720}},
		})
		root.PlayerLinks.Playlist["1"][name] = data
	}
	links, err := proxylink.New(proxylink.Options{CacheDir: t.TempDir(), EncryptAES: true})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "https://ours.test/lite/filmix?s=1&e=3&audio_mux=1", nil)
	rec := httptest.NewRecorder()
	checker.writeAudioMux(rec, req, root, 1, 0, "test", links)
	if rec.Code != 200 {
		t.Fatalf("API failed: %d %s", rec.Code, rec.Body.String())
	}
	var result struct {
		URL      string            `json:"url"`
		Tracks   int               `json:"tracks"`
		Episodes map[string]string `json:"episodes"`
	}
	if err := stdjson.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Tracks != 2 || result.Episodes["3"] != result.URL || result.Episodes["4"] == "" {
		t.Fatalf("bad response: %s", rec.Body.String())
	}
	u, _ := url.Parse(result.URL)
	key := strings.TrimSuffix(strings.TrimPrefix(u.Path, filmixAudioPrefix), ".m3u8")
	filmixAudioJobs.Lock()
	job := filmixAudioJobs.items[key]
	filmixAudioJobs.Unlock()
	if job == nil || !strings.Contains(job.video, "_2160.mp4/index-v1.m3u8") {
		t.Fatal("maximum premium video was not selected")
	}
	for _, e := range []string{"3", "4"} {
		u, _ := url.Parse(result.Episodes[e])
		if !strings.HasPrefix(u.Path, filmixAudioPrefix) {
			t.Fatal("wrong capability route")
		}
		rec := httptest.NewRecorder()
		FilmixAudioMasterHandler(rec, httptest.NewRequest(http.MethodGet, u.String(), nil))
		if rec.Code != 200 || strings.Count(rec.Body.String(), "#EXT-X-MEDIA:TYPE=AUDIO") != 2 || strings.Contains(rec.Body.String(), srv.URL) {
			t.Fatalf("master failed: %d %s", rec.Code, rec.Body.String())
		}
	}
}

func TestFilmixAudioMissingExpiredAndFailedJob(t *testing.T) {
	for _, path := range []string{filmixAudioPrefix + "missing.m3u8", filmixAudioPrefix + "../../etc/passwd"} {
		r := httptest.NewRecorder()
		FilmixAudioMasterHandler(r, httptest.NewRequest("GET", path, nil))
		if r.Code != 404 {
			t.Fatal("unknown capability accepted")
		}
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(403) }))
	defer srv.Close()
	j := &filmixAudioJob{client: srv.Client(), video: srv.URL, fallback: "https://ours.test/proxy/original.m3u8"}
	id, err := registerFilmixAudioJob(j)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRecorder()
	FilmixAudioMasterHandler(r, httptest.NewRequest("GET", filmixAudioPrefix+id, nil))
	if r.Code != 307 || r.Header().Get("Location") != j.fallback {
		t.Fatal("failed job did not fall back")
	}
	j.created = time.Now().Add(-4 * time.Hour)
	r = httptest.NewRecorder()
	FilmixAudioMasterHandler(r, httptest.NewRequest("GET", filmixAudioPrefix+id, nil))
	if r.Code != 404 {
		t.Fatal("expired capability accepted")
	}
}
